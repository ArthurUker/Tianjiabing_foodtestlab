import { PrismaClient } from '@prisma/client'
import bcryptjs from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 开始数据库初始化...')

  // 清空数据库（仅在开发环境）
  if (process.env.NODE_ENV !== 'production') {
    console.log('  清理旧数据...')
    await prisma.testItem.deleteMany({})
    await prisma.attachment.deleteMany({})
    await prisma.testRecord.deleteMany({})
    await prisma.guest.deleteMany({})
    await prisma.auditLog.deleteMany({})
    await prisma.user.deleteMany({})
    await prisma.systemLog.deleteMany({})
    console.log('  ✅ 旧数据已清理')
  }

  // 创建默认管理员账户
  const adminPassword = 'eI8ORfLDEOyHbf95' // 与 deployment 一致
  const adminPasswordHash = await bcryptjs.hash(adminPassword, 10)

  try {
    const admin = await prisma.user.upsert({
      where: { username: 'admin' },
      update: {},
      create: {
        username: 'admin',
        email: 'admin@foodlab.local',
        password_hash: adminPasswordHash,
        full_name: 'Administrator',
        phone: null,
        role: 'admin',
        status: 'active'
      }
    })
    console.log(`✅ 管理员账户就绪: ${admin.username}`)
  } catch (err) {
    console.error(`❌ 创建管理员账户失败: ${err.message}`)
  }

  // 创建示例测试员
  const operatorPassword = 'operator123'
  const operatorPasswordHash = await bcryptjs.hash(operatorPassword, 10)

  try {
    const operator = await prisma.user.upsert({
      where: { username: 'operator' },
      update: {},
      create: {
        username: 'operator',
        email: 'operator@foodlab.local',
        password_hash: operatorPasswordHash,
        full_name: 'Test Operator',
        phone: null,
        role: 'operator',
        status: 'active'
      }
    })
    console.log(`✅ 测试员账户就绪: ${operator.username}`)
  } catch (err) {
    console.error(`❌ 创建测试员账户失败: ${err.message}`)
  }

  // 创建示例查看员
  const viewerPassword = 'viewer123'
  const viewerPasswordHash = await bcryptjs.hash(viewerPassword, 10)

  try {
    const viewer = await prisma.user.upsert({
      where: { username: 'viewer' },
      update: {},
      create: {
        username: 'viewer',
        email: 'viewer@foodlab.local',
        password_hash: viewerPasswordHash,
        full_name: 'Report Viewer',
        phone: null,
        role: 'viewer',
        status: 'active'
      }
    })
    console.log(`✅ 查看员账户就绪: ${viewer.username}`)
  } catch (err) {
    console.error(`❌ 创建查看员账户失败: ${err.message}`)
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
  console.log('\n📝 测试账户:')
  console.log('  - admin / eI8ORfLDEOyHbf95 (管理员)')
  console.log('  - operator / operator123 (测试员)')
  console.log('  - viewer / viewer123 (查看员)\n')
}

main()
  .catch((e) => {
    console.error('❌ 初始化失败:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
