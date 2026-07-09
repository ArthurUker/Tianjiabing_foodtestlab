import { PrismaClient } from '@prisma/client'
import bcryptjs from 'bcryptjs'

// 需在 .env 中配置 SEED_ADMIN_PASSWORD / SEED_OPERATOR_PASSWORD / SEED_VIEWER_PASSWORD
const adminPassword = process.env.SEED_ADMIN_PASSWORD
const operatorPassword = process.env.SEED_OPERATOR_PASSWORD
const viewerPassword = process.env.SEED_VIEWER_PASSWORD

if (!adminPassword || !operatorPassword || !viewerPassword) {
  console.error('[FATAL] 缺少必要的环境变量：SEED_ADMIN_PASSWORD、SEED_OPERATOR_PASSWORD、SEED_VIEWER_PASSWORD 必须全部在 .env 中配置。')
  console.error('[FATAL] 请参考 .env.example 完成配置后再执行 seed。')
  process.exit(1)
}

const prisma = new PrismaClient()

// P2-12: 生产环境默认禁止创建测试账号，防止默认凭据泄露风险
// 如需在生产环境初始化，须显式设置 SEED_ALLOW_PROD=true
if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PROD !== 'true') {
  console.warn('[SKIP] 生产环境检测到 (NODE_ENV=production)，已跳过测试账号初始化。')
  console.warn('[SKIP] 如确需在生产环境创建初始账号，请设置 SEED_ALLOW_PROD=true 后重新执行。')
  await prisma.$disconnect()
  process.exit(0)
}

async function main() {
  console.log('🌱 开始数据库初始化...')

  // 仅在账号不存在时创建默认账号，避免每次部署覆盖已修改密码。
  async function ensureUser(user, plainPassword) {
    const existed = await prisma.user.findUnique({ where: { username: user.username } })
    if (existed) {
      console.log(`ℹ️ 账户已存在，跳过: ${user.username}`)
      return
    }

    const passwordHash = await bcryptjs.hash(plainPassword, 10)
    await prisma.user.create({
      data: {
        ...user,
        password_hash: passwordHash
      }
    })
    console.log(`✅ 已创建初始账户: ${user.username}`)
  }

  try {
    await ensureUser(
      {
        username: 'admin',
        email: 'admin@zhuhaiyizhong.edu.cn',
        full_name: 'Administrator',
        phone: null,
        role: 'admin',
        status: 'active'
      },
      adminPassword
    )

    await ensureUser(
      {
        username: 'operator',
        email: 'operator@foodlab.local',
        full_name: 'Test Operator',
        phone: null,
        role: 'operator',
        status: 'active'
      },
      operatorPassword
    )

    await ensureUser(
      {
        username: 'viewer',
        email: 'viewer@foodlab.local',
        full_name: 'Report Viewer',
        phone: null,
        role: 'viewer',
        status: 'active'
      },
      viewerPassword
    )
  } catch (err) {
    console.error(`❌ 初始化默认账户失败: ${err.message}`)
  }

  // 记录初始化日志（[FIX 3.1] 去重，避免每次部署重复插入）
  const existingLog = await prisma.systemLog.findFirst({
    where: { message: '数据库初始化完成' }
  })
  if (!existingLog) {
    await prisma.systemLog.create({
      data: {
        level: 'info',
        message: '数据库初始化完成',
        context: JSON.stringify({ timestamp: new Date().toISOString() })
      }
    })
  }

  console.log('✨ 数据库初始化完成！')
  console.log('\n📝 初始账户（仅首次创建）:')
  console.log('  - admin (管理员)')
  console.log('  - operator (测试员)')
  console.log('  - viewer (查看员)\n')
}

main()
  .catch((e) => {
    console.error('❌ 初始化失败:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
