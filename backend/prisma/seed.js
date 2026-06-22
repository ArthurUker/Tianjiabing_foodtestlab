import { PrismaClient } from '@prisma/client'
import bcryptjs from 'bcryptjs'

// 需在 .env 中配置 SEED_ADMIN_PASSWORD / SEED_OPERATOR_PASSWORD / SEED_VIEWER_PASSWORD
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Zhuhai@2026!Admin'
const operatorPassword = process.env.SEED_OPERATOR_PASSWORD || 'Zhuhai@2026!Operator'
const viewerPassword = process.env.SEED_VIEWER_PASSWORD || 'Zhuhai@2026!Viewer'

const prisma = new PrismaClient()

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

  // 记录初始化日志
  await prisma.systemLog.create({
    data: {
      level: 'info',
      message: '数据库初始化完成',
      context: JSON.stringify({ timestamp: new Date().toISOString() })
    }
  })

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
