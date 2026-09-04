import { PrismaClient } from '@prisma/client'
import bcryptjs from 'bcryptjs'

// 需在 .env 中配置 SEED_ADMIN_PASSWORD
// 初始账号设计（TS-InitAccount）：首次初始化只创建平台超管 admin（public schema, schoolCode=null）。
// 预设学校的 manager 账号由 provisionSchool（建校/租户初始化）创建；若无预设学校，则只有 admin。
// operator/viewer 等角色账号不在此创建——由超管在控制台按需为学校添加（角色归属学校）。
const adminPassword = process.env.SEED_ADMIN_PASSWORD

if (!adminPassword) {
  console.error('[FATAL] 缺少必要的环境变量：SEED_ADMIN_PASSWORD 必须在 .env 中配置。')
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
    // M2: 初始密码属于"临时密码"，一律置 must_change_password=true，首登强制改密。
    // 与建校 manager（tenantProvisioner）/ 管理员重置密码（resetPassword）的口径保持一致；
    // 登录侧拦截由前端登录页（mustChangePassword）与后端 authenticateUser
    // （非改密白名单接口 403，code: MUST_CHANGE_PASSWORD）双重实现。
    await prisma.user.create({
      data: {
        ...user,
        password_hash: passwordHash,
        must_change_password: true
      }
    })
    console.log(`✅ 已创建初始账户: ${user.username}（must_change_password=true，首登需改密）`)
  }

  try {
    // TS-InitAccount：仅创建平台超管 admin。预设学校 manager 由 provisionSchool 创建。
    await ensureUser(
      {
        username: 'admin',
        email: 'admin@foodsentinel.local',
        full_name: 'Administrator',
        phone: null,
        role: 'admin',
        status: 'active'
      },
      adminPassword
    )
  } catch (err) {
    console.error(`❌ 初始化默认账户失败: ${err.message}`)
  }

  // [W6-SEED-School] 系统表 School / SchoolCustomization 种子
  // 登录页主题/Logo 个性化依赖此数据；缺失时优雅降级（不影响功能）。
  // TS-InitAccount：学校代码取 SCHOOL_CODES（与 provision-tenants 一致）。
  // 未配置 SCHOOL_CODES 时不建任何学校（系统只有平台超管 admin，学校由超管在
  // 控制台建校时 provisionSchool 初始化），避免 seed 创建虚假的 "demo" 学校。
  const schoolCodes = (process.env.SCHOOL_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  async function ensureSchool(code, name, themeColor) {
    const existed = await prisma.school.findUnique({ where: { code } })
    if (existed) {
      console.log(`ℹ️ School 已存在，跳过: ${code}`)
      return
    }
    await prisma.school.create({
      data: { code, name, theme_color: themeColor }
    })
    await prisma.schoolCustomization.create({
      // P1-4: theme_config 已由 String? 改为 Json?（jsonb），直接传对象，Prisma 自动序列化
      data: { school_code: code, theme_config: { theme_color: themeColor } }
    })
    console.log(`✅ 已创建系统学校记录: ${code}`)
  }
  for (const code of schoolCodes) {
    await ensureSchool(
      code,
      process.env[`SCHOOL_NAME_${code}`] || `学校(${code})`,
      '#1a73e8'
    )
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
  console.log('  - admin (平台超管)')
  console.log('  - 各预设学校 manager（由建校初始化 provisionSchool 创建）\n')
}

main()
  .catch((e) => {
    console.error('❌ 初始化失败:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
