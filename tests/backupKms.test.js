/**
 * backupKms — 备份加密模块单元测试（P0 备份引擎）
 * 覆盖：信封加密 roundtrip、fail-closed（无密钥拒绝）、密文篡改检测（GCM 认证）、meta 结构。
 * 纯逻辑测试，不依赖数据库 / pg_dump。
 */
import crypto from 'node:crypto'
import { encryptFile, decryptFile, sealDek, openDek, kmsMode } from '../backend/lib/backupKms.js'

const KEY = crypto.randomBytes(32).toString('base64')

describe('backupKms 信封加密（local 模式）', () => {
  beforeEach(() => {
    delete process.env.TENCENT_SECRET_ID
    delete process.env.TENCENT_SECRET_KEY
    delete process.env.TENCENT_KMS_REGION
    delete process.env.TENCENT_KMS_KEY_ID
    process.env.BACKUP_MASTER_KEY = KEY
  })
  afterEach(() => { delete process.env.BACKUP_MASTER_KEY })

  test('未配置任何主密钥时 kmsMode 返回 null（fail-closed 前提）', () => {
    delete process.env.BACKUP_MASTER_KEY
    expect(kmsMode()).toBeNull()
  })

  test('encryptFile → decryptFile roundtrip 且 meta 结构正确', async () => {
    const plaintext = Buffer.from('CREATE TABLE "school_demo"."TestRecord" (...);\nCOPY "school_demo"."TestRecord" FROM stdin;')
    const { cipherBuf, meta } = await encryptFile(plaintext)

    expect(meta.algorithm).toBe('aes-256-gcm')
    expect(meta.mode).toBe('local')
    // 修复后的扁平结构：keyMeta.dekCipher 必须是字符串（曾出现嵌套对象导致解密失败）
    expect(typeof meta.keyMeta.dekCipher).toBe('string')
    expect(typeof meta.iv).toBe('string')
    expect(typeof meta.tag).toBe('string')

    const recovered = await decryptFile(cipherBuf, meta)
    expect(recovered.equals(plaintext)).toBe(true)
  })

  test('密文任一字节被篡改 → GCM 认证失败（拒绝解密）', async () => {
    const { cipherBuf, meta } = await encryptFile(Buffer.from('sensitive data'))
    cipherBuf[0] ^= 0xff
    await expect(decryptFile(cipherBuf, meta)).rejects.toThrow()
  })

  test('meta 缺失或算法不匹配 → 拒绝解密', async () => {
    const { cipherBuf } = await encryptFile(Buffer.from('x'))
    await expect(decryptFile(cipherBuf, {})).rejects.toThrow()
    await expect(decryptFile(cipherBuf, { algorithm: 'aes-128-cbc' })).rejects.toThrow()
  })

  test('无密钥时 sealDek fail-closed（拒绝执行未加密备份）', async () => {
    delete process.env.BACKUP_MASTER_KEY
    await expect(sealDek(crypto.randomBytes(32))).rejects.toThrow()
  })

  test('openDek 与 sealDek 配对往返', async () => {
    const dek = crypto.randomBytes(32)
    const { mode, keyMeta } = await sealDek(dek)
    const recovered = await openDek(keyMeta, mode)
    expect(recovered.equals(dek)).toBe(true)
  })
})
