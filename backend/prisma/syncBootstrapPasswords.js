// prisma/syncBootstrapPasswords.js
// 每次部署由 deploy.sh 调用：把库内 bootstrap 账号的 password_hash 同步为 .env 当前密码。
//
// 背景：seed.js 仅在首次部署创建账号（ensureUser 跳过已存在用户），重部署不会更新
// password_hash；若 .env 的 SEED_*_PASSWORD 曾被重新随机，库内 hash 与 .env 不一致，
// 会导致登录 401。此处显式对齐，确保登录始终可用
// （类比 PostgreSQL ALTER ROLE 同步角色密码——库内密钥必须跟随 .env 当前值）。

import { PrismaClient } from '@prisma/client'
import bcryptjs from 'bcryptjs'
import { schemaNameOf } from '../lib/tenantClient.js'

const adminPw = process.env.SEED_ADMIN_PASSWORD
const operatorPw = process.env.SEED_OPERATOR_PASSWORD
const viewerPw = process.env.SEED_VIEWER_PASSWORD

if (!adminPw || !operatorPw || !viewerPw) {
  console.error('[FATAL] 缺少 SEED_ADMIN_PASSWORD / SEED_OPERATOR_PASSWORD / SEED_VIEWER_PASSWORD，无法同步密码')
  process.exit(1)
}

const publicClient = new PrismaClient()

async function syncPublic() {
  const map = [
    ['admin', adminPw],
    ['operator', operatorPw],
    ['viewer', viewerPw],
  ]
  for (const [username, pw] of map) {
    const hash = await bcryptjs.hash(pw, 10)
    const r = await publicClient.user.updateMany({
      where: { username },
      data: { password_hash: hash, status: 'active' },
    })
    console.log(`[public] ${username}: 已同步密码 (rows=${r.count})`)
  }
}

async function syncTenants() {
  const baseUrl = (process.env.DATABASE_URL || '').split('?')[0]
  if (!baseUrl) return
  const codes = (process.env.SCHOOL_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const code of codes) {
    const schema = schemaNameOf(code)
    const url = `${baseUrl}?schema=${schema}`
    const client = new PrismaClient({ datasources: { db: { url } } })
    try {
      const hash = await bcryptjs.hash(adminPw, 10)
      const r = await client.user.updateMany({
        where: { username: 'admin' },
        data: { password_hash: hash, status: 'active' },
      })
      console.log(`[${schema}] admin: 已同步密码 (rows=${r.count})`)
    } finally {
      await client.$disconnect()
    }
  }
}

async function main() {
  await syncPublic()
  await syncTenants()
}

main()
  .catch((e) => {
    console.error('❌ 同步密码失败:', e)
    process.exit(1)
  })
  .finally(async () => {
    await publicClient.$disconnect()
  })
