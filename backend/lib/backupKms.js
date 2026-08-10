// backupKms.js — 备份文件密钥管理（P0：AES-256-GCM 信封加密的密钥源，可插拔）
//
// 设计目标：备份文件在静态存储（磁盘 / COS）上必须加密（P0 基线，非可选项）。
// 加密采用「信封加密」：
//   ① 每次备份生成随机数据密钥 DEK（32B）
//   ② DEK 加密备份文件（AES-256-GCM）
//   ③ DEK 本身用主密钥加密（KMS CMK 或本地主密钥），密文随 meta.json 同存
// 恢复时：用主密钥解出 DEK → 解出明文 → pg_restore。
//
// 主密钥两种模式（由环境变量决定，fail-closed，无密钥即拒绝执行）：
//   模式A【生产推荐】腾讯云 KMS：
//     配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_KMS_REGION / TENCENT_KMS_KEY_ID。
//     CMK 永不出 KMS，DEK 密文经 KMS Encrypt/Decrypt 往返；支持 CAM 审计与密钥轮换。
//     依赖 tencentcloud-sdk-nodejs（npm i tencentcloud-sdk-nodejs；未安装时明确报错，不静默降级）。
//   模式B【仅开发/过渡】BACKUP_MASTER_KEY（32 字节主密钥的 base64）：
//     本地主密钥直接用于加解密 DEK；⚠️ 主密钥以明文存在于服务器环境，仅限无 KMS 的过渡期，
//     生产上线前必须切换到模式A（见 docs/backup/backup-module.md）。
//
// 原则：密钥不可用 → throw（fail-closed），绝不明文降级。

import crypto from 'node:crypto'

const TAG = '[backupKms]'
const ALGO = 'aes-256-gcm'

/**
 * 返回当前主密钥模式：'kms' | 'local'。两者都未配置时返回 null（调用方应拒绝执行）。
 */
export function kmsMode() {
  const kmsConfigured =
    process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY &&
    process.env.TENCENT_KMS_REGION && process.env.TENCENT_KMS_KEY_ID
  if (kmsConfigured) return 'kms'
  if (process.env.BACKUP_MASTER_KEY) return 'local'
  return null
}

/** 模式A：懒加载腾讯云 KMS 客户端（未安装 SDK 时给出明确指引而非难懂报错）。 */
async function getKmsClient() {
  try {
    const tencentcloud = await import('tencentcloud-sdk-nodejs')
    const { kms } = tencentcloud
    return new kms.v20190118.Client({
      credential: {
        secretId: process.env.TENCENT_SECRET_ID,
        secretKey: process.env.TENCENT_SECRET_KEY,
      },
      region: process.env.TENCENT_KMS_REGION,
      profile: { httpProfile: { endpoint: 'kms.tencentcloudapi.com' } },
    })
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        `${TAG} 未安装 tencentcloud-sdk-nodejs，无法使用 KMS 模式。` +
        `请在 backend 目录执行 npm i tencentcloud-sdk-nodejs 后重试。`
      )
    }
    throw e
  }
}

/** 用 KMS CMK 加密 DEK（信封外层）。 */
async function kmsEncryptDek(dek) {
  const client = await getKmsClient()
  const resp = await client.Encrypt({
    KeyId: process.env.TENCENT_KMS_KEY_ID,
    Plaintext: dek.toString('base64'),
  })
  return { dekCipher: resp.CiphertextBlob, kmsKeyId: resp.KeyId }
}

/** 用 KMS CMK 解密 DEK。 */
async function kmsDecryptDek(dekCipher) {
  const client = await getKmsClient()
  const resp = await client.Decrypt({ CiphertextBlob: dekCipher })
  return Buffer.from(resp.Plaintext, 'base64')
}

/** 本地主密钥（模式B）：解析 BACKUP_MASTER_KEY 为 32 字节 Buffer。 */
function localMasterKey() {
  const b64 = process.env.BACKUP_MASTER_KEY
  if (!b64) throw new Error(`${TAG} BACKUP_MASTER_KEY 未配置（模式B 必需）`)
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) {
    throw new Error(`${TAG} BACKUP_MASTER_KEY 必须是 32 字节密钥的 base64（生成：openssl rand -base64 32）`)
  }
  return key
}

/** 用本地主密钥加密 DEK（模式B 的信封外层，同样走 AES-256-GCM），返回 base64 字符串。 */
function localEncryptDek(dek) {
  const key = localMasterKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()])
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')
}

/** 用本地主密钥解密 DEK。 */
function localDecryptDek(encoded) {
  const key = localMasterKey()
  const buf = Buffer.from(encoded, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const ciphertext = buf.subarray(12, buf.length - 16)
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * 信封外层：用主密钥加密 DEK（供流式加密复用，避免整块读入内存）。
 * @param {Buffer} dek 32 字节数据密钥
 * @returns {Promise<{mode: 'kms'|'local', keyMeta: object}>}
 */
export async function sealDek(dek) {
  const mode = kmsMode()
  if (!mode) {
    throw new Error(
      `${TAG} 未配置任何加密主密钥：生产请配置 TENCENT_*（KMS 模式）` +
      `，仅开发可配置 BACKUP_MASTER_KEY。fail-closed：拒绝执行未加密备份。`
    )
  }
  const keyMeta = mode === 'kms'
    ? await kmsEncryptDek(dek)
    : { dekCipher: localEncryptDek(dek) }
  return { mode, keyMeta }
}

/**
 * 信封外层逆操作：用主密钥解出 DEK。
 * @param {object} keyMeta
 * @param {'kms'|'local'} mode
 * @returns {Promise<Buffer>}
 */
export async function openDek(keyMeta, mode) {
  if (!keyMeta || !keyMeta.dekCipher) throw new Error(`${TAG} meta 缺少 keyMeta.dekCipher`)
  return mode === 'kms'
    ? kmsDecryptDek(keyMeta.dekCipher)
    : localDecryptDek(keyMeta.dekCipher)
}

/**
 * 加密一个 Buffer（备份文件明文）→ { cipherBuf, meta }。
 * meta 记录 mode / keyMeta / iv / tag，解密与恢复依赖它。
 * @param {Buffer} plaintext
 * @returns {Promise<{cipherBuf: Buffer, meta: object}>}
 */
export async function encryptFile(plaintext) {
  // ① 随机 DEK
  const dek = crypto.randomBytes(32)
  // ② DEK 加密文件
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, dek, iv)
  const cipherBuf = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  // ③ 主密钥加密 DEK（信封外层）
  const { mode, keyMeta } = await sealDek(dek)
  const meta = {
    version: 1,
    algorithm: ALGO,
    mode,
    keyMeta,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    createdAt: new Date().toISOString(),
  }
  return { cipherBuf, meta }
}

/**
 * 解密备份文件 Buffer。
 * @param {Buffer} cipherBuf
 * @param {object} meta 与文件同存的 meta.json
 * @returns {Promise<Buffer>} 明文
 */
export async function decryptFile(cipherBuf, meta) {
  if (!meta || meta.algorithm !== ALGO) {
    throw new Error(`${TAG} meta.json 缺失或算法不匹配，拒绝解密`)
  }
  const dek = await openDek(meta.keyMeta, meta.mode)
  const iv = Buffer.from(meta.iv, 'base64')
  const tag = Buffer.from(meta.tag, 'base64')
  const decipher = crypto.createDecipheriv(ALGO, dek, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(cipherBuf), decipher.final()])
}
