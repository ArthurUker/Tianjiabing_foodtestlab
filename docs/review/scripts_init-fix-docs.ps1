# ============================================================
# init-fix-docs.ps1
# 自动生成 docs/fix/ 下所有修复文档骨架（37个文件）
#
# 目录结构：
#   docs/fix/
#   ├── FIX_PLAN.md
#   ├── P0/   (9个文件)
#   ├── P1/   (23个文件)
#   ├── P2/   (20个文件)
#   └── DOCS/ (4个文件)
#
# 用法（在项目根目录执行）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\init-fix-docs.ps1
# ============================================================

# 获取项目根目录（脚本所在目录的上一级）
$rootDir = Split-Path -Parent $PSScriptRoot
$baseDir  = Join-Path $rootDir "docs\fix"

# ── 所有修复任务定义 ──────────────────────────────────────────
# 格式：ID | 子目录 | 文件名 | 标题 | 影响文件 | 预估工时 | 关联问题
$fixes = @(
  # P0 高危（9项）
  @{ id="P0-01"; dir="P0"; file="FIX_P0-01_syncRoutes.md";         title="syncRoutes.js 无认证 + 不操作DB + CommonJS 三重问题";    affects="backend/routes/syncRoutes.js";                              hours="4h";   related="P1-16" },
  @{ id="P0-02"; dir="P0"; file="FIX_P0-02_authMiddleware.md";     title="authenticateUser 中间件三处实现不一致";                   affects="backend/server.js, userRoutes.js, auditRoutes.js";          hours="3h";   related="P0-01, P0-04" },
  @{ id="P0-03"; dir="P0"; file="FIX_P0-03_jwtSecret.md";          title="JWT 密钥 fallback 为弱明文字符串";                        affects="backend/server.js";                                         hours="0.5h"; related="-" },
  @{ id="P0-04"; dir="P0"; file="FIX_P0-04_registerEndpoint.md";   title="POST /api/user/register 完全公开无需授权";                affects="backend/routes/userRoutes.js";                              hours="0.5h"; related="P0-02" },
  @{ id="P0-05"; dir="P0"; file="FIX_P0-05_seedPassword.md";       title="seed.js 初始密码明文写入公开仓库";                        affects="backend/prisma/seed.js + 生产环境账号";                     hours="1h";   related="P2-12" },
  @{ id="P0-06"; dir="P0"; file="FIX_P0-06_recordCode.md";         title="record_code 双重生成逻辑导致幂等性失效";                  affects="backend/server.js, backend/prisma/schema.prisma";           hours="3h";   related="P1-15" },
  @{ id="P0-07"; dir="P0"; file="FIX_P0-07_quickAccess.md";        title="快速访问模式完全绕过后端认证";                            affects="js/services/GuestAuthService.js, login.html";               hours="4h";   related="P1-18, P2-19" },
  @{ id="P0-08"; dir="P0"; file="FIX_P0-08_storageHeaders.md";     title="Storage.js _getHeaders() Token 注入机制待确认";           affects="js/core/Storage.js";                                        hours="1h";   related="P1-14" },
  @{ id="P0-09"; dir="P0"; file="FIX_P0-09_authVerify.md";         title="auth.verify() 对编辑操作完全不做权限校验";                affects="js/core/Auth.js, Tableware.js, GenericTest.js, Pathogen.js";hours="3h";   related="P1-21" },
  # P1 重要（23项）
  @{ id="P1-01"; dir="P1"; file="FIX_P1-01_auditRouteOrder.md";    title="auditRoutes.js 路由注册顺序冲突";                         affects="backend/routes/auditRoutes.js";                             hours="0.5h"; related="P2-15" },
  @{ id="P1-02"; dir="P1"; file="FIX_P1-02_idempotencyMemory.md";  title="幂等性中间件使用内存存储，PM2重启后全部失效";             affects="backend/middleware/idempotencyMiddleware.js";               hours="2h";   related="-" },
  @{ id="P1-03"; dir="P1"; file="FIX_P1-03_fakeEmail.md";          title="UserManager 注册时自动生成虚假 email";                    affects="backend/modules/UserManager.js";                            hours="0.5h"; related="-" },
  @{ id="P1-04"; dir="P1"; file="FIX_P1-04_passwordStrength.md";   title="密码强度校验过弱（仅要求 length >= 6）";                  affects="backend/modules/UserManager.js";                            hours="1h";   related="-" },
  @{ id="P1-05"; dir="P1"; file="FIX_P1-05_refreshToken.md";       title="AuthService.refreshToken() 调用后端不存在的接口";         affects="js/services/AuthService.js, backend/routes/userRoutes.js"; hours="2h";   related="-" },
  @{ id="P1-06"; dir="P1"; file="FIX_P1-06_cssPermission.md";      title="前端权限控制完全依赖 CSS hidden，可被 DevTools 绕过";     affects="js/core/Router.js, 各业务模块";                             hours="3h";   related="P0-09" },
  @{ id="P1-07"; dir="P1"; file="FIX_P1-07_windowRouter.md";       title="Router.js 将自身暴露到 window.router 全局作用域";         affects="js/core/Router.js";                                         hours="0.5h"; related="P2-10" },
  @{ id="P1-08"; dir="P1"; file="FIX_P1-08_cascadeDelete.md";      title="TestRecord 的 onDelete:Cascade 可能导致数据意外丢失";     affects="backend/prisma/schema.prisma";                              hours="1h";   related="-" },
  @{ id="P1-09"; dir="P1"; file="FIX_P1-09_auditDualSystem.md";    title="两套并行审计日志机制并存，职责边界混乱";                  affects="js/utils/AuditLogger.js, js/services/AuditLogService.js";  hours="2h";   related="-" },
  @{ id="P1-10"; dir="P1"; file="FIX_P1-10_permissionCache.md";    title="PermissionService 权限缓存永不失效";                      affects="js/services/PermissionService.js";                          hours="1h";   related="-" },
  @{ id="P1-11"; dir="P1"; file="FIX_P1-11_sessionManager.md";     title="SessionManager 会话全存内存且 IP 硬编码";                 affects="js/services/SessionManager.js";                             hours="2h";   related="-" },
  @{ id="P1-12"; dir="P1"; file="FIX_P1-12_telemetryCommonJS.md";  title="telemetry.js 使用 CommonJS 且未集成到主进程";             affects="backend/config/telemetry.js";                               hours="1h";   related="-" },
  @{ id="P1-13"; dir="P1"; file="FIX_P1-13_corsOrigin.md";         title="CORS_ORIGIN 配置在代码与环境变量间不一致";                affects="backend/server.js, .env.example";                           hours="0.5h"; related="-" },
  @{ id="P1-14"; dir="P1"; file="FIX_P1-14_storageCache.md";       title="Storage.getAll() 优先返回本地缓存，数据一致性无保障";     affects="js/core/Storage.js";                                        hours="2h";   related="P0-08" },
  @{ id="P1-15"; dir="P1"; file="FIX_P1-15_dedupeRoot.md";         title="生产环境重复数据根因未根治";                              affects="backend/server.js, schema.prisma";                          hours="1h";   related="P0-06" },
  @{ id="P1-16"; dir="P1"; file="FIX_P1-16_backupRestore.md";      title="BackupRestore.js 备份恢复依赖无效的 syncRoutes";          affects="js/modules/BackupRestore.js";                               hours="2h";   related="P0-01" },
  @{ id="P1-17"; dir="P1"; file="FIX_P1-17_userMgmtDelete.md";     title="UserManagement 删除操作无二次确认且无后端权限校验";       affects="js/modules/UserManagement.js";                              hours="1h";   related="-" },
  @{ id="P1-18"; dir="P1"; file="FIX_P1-18_pathogenGuest.md";      title="访客可访问病原体检测模块，与权限矩阵矛盾";                affects="js/modules/Pathogen.js";                                    hours="0.5h"; related="P0-07" },
  @{ id="P1-19"; dir="P1"; file="FIX_P1-19_fingerprintEvict.md";   title="AdaptiveUploadQueue 指纹缓存淘汰策略未确认";              affects="js/core/AdaptiveUploadQueue.js";                            hours="1h";   related="-" },
  @{ id="P1-20"; dir="P1"; file="FIX_P1-20_dashboardGlobal.md";    title="Dashboard.js 全局函数挂载 + 5个StorageService实例";       affects="js/modules/Dashboard.js";                                   hours="2h";   related="P2-10" },
  @{ id="P1-21"; dir="P1"; file="FIX_P1-21_authClassRename.md";    title="Auth.js 与 AuthService.js 类名完全相同导致混淆";          affects="js/core/Auth.js";                                           hours="1h";   related="P0-09" },
  @{ id="P1-22"; dir="P1"; file="FIX_P1-22_sampleDataId.md";       title="SampleDataGenerator 示例数据 ID 格式与 StorageService 不兼容"; affects="js/utils/SampleDataGenerator.js";                      hours="1h";   related="-" },
  @{ id="P1-23"; dir="P1"; file="FIX_P1-23_validatorSync.md";      title="前端 FormValidator 校验规则与后端 validationMiddleware 不同步"; affects="js/utils/FormValidator.js, validationMiddleware.js";   hours="2h";   related="-" },
  # P2 优化（20项）
  @{ id="P2-01"; dir="P2"; file="FIX_P2-01_rateLimit.md";          title="登录接口无专项限流，默认限流阈值过高";                    affects="backend/server.js";                                         hours="0.5h"; related="-" },
  @{ id="P2-02"; dir="P2"; file="FIX_P2-02_auditCrud.md";          title="检测记录 CRUD 操作未在后端层自动写入审计日志";            affects="backend/server.js";                                         hours="2h";   related="P1-09" },
  @{ id="P2-03"; dir="P2"; file="FIX_P2-03_failedLoginLog.md";     title="失败登录日志未确认写入数据库";                            affects="backend/modules/UserManager.js";                            hours="0.5h"; related="-" },
  @{ id="P2-04"; dir="P2"; file="FIX_P2-04_jsonParseSafe.md";      title="AuthService.getUser() JSON.parse 无容错处理";             affects="js/services/AuthService.js";                                hours="0.5h"; related="-" },
  @{ id="P2-05"; dir="P2"; file="FIX_P2-05_guestAuthSingleton.md"; title="Router.init() 每次调用都实例化新的 GuestAuthService";     affects="js/core/Router.js";                                         hours="0.5h"; related="-" },
  @{ id="P2-06"; dir="P2"; file="FIX_P2-06_healthDuplicate.md";    title="/api/health 与 /health 重复定义";                         affects="backend/server.js";                                         hours="0.5h"; related="-" },
  @{ id="P2-07"; dir="P2"; file="FIX_P2-07_recordSchemaValidation.md"; title="buildRecordWriteData() 字段提取无 Schema 验证";        affects="backend/server.js";                                         hours="2h";   related="-" },
  @{ id="P2-08"; dir="P2"; file="FIX_P2-08_backupForeignKey.md";   title="Backup 模型缺少关联用户外键约束";                         affects="backend/prisma/schema.prisma";                              hours="1h";   related="-" },
  @{ id="P2-09"; dir="P2"; file="FIX_P2-09_networkHelperUrl.md";   title="NetworkHelper 硬编码 Google URL，内网环境不可达";         affects="js/utils/NetworkHelper.js";                                 hours="0.5h"; related="-" },
  @{ id="P2-10"; dir="P2"; file="FIX_P2-10_windowGlobal.md";       title="main.js 和 Dashboard.js 大量函数通过 window.* 全局暴露"; affects="js/main.js, js/modules/Dashboard.js";                       hours="2h";   related="P1-07, P1-20" },
  @{ id="P2-11"; dir="P2"; file="FIX_P2-11_guestJsonParse.md";     title="GuestAuthService.getCurrentGuest() JSON.parse 无容错";    affects="js/services/GuestAuthService.js";                           hours="0.5h"; related="P2-04" },
  @{ id="P2-12"; dir="P2"; file="FIX_P2-12_seedProdAccounts.md";   title="seed.js 测试账号在生产环境应禁用";                        affects="backend/prisma/seed.js";                                    hours="0.5h"; related="P0-05" },
  @{ id="P2-13"; dir="P2"; file="FIX_P2-13_tempIdCollision.md";    title="tempId 使用 Date.now()+Math.random()，多标签页可能碰撞";  affects="js/core/Storage.js";                                        hours="1h";   related="-" },
  @{ id="P2-14"; dir="P2"; file="FIX_P2-14_exportStaleData.md";    title="ExportService 导出数据完全来自本地缓存，可能过期";        affects="js/services/ExportService.js";                              hours="1h";   related="P1-14" },
  @{ id="P2-15"; dir="P2"; file="FIX_P2-15_auditStatsRoute.md";    title="AuditLogService.getStats() 路由路径与 P1-01 冲突";        affects="js/services/AuditLogService.js";                            hours="0h";   related="P1-01" },
  @{ id="P2-16"; dir="P2"; file="FIX_P2-16_mammothSri.md";         title="Pathogen.js 动态加载 Mammoth.js 无 SRI 完整性校验";       affects="js/modules/Pathogen.js";                                    hours="0.5h"; related="-" },
  @{ id="P2-17"; dir="P2"; file="FIX_P2-17_genericTestInherit.md"; title="各检测模块未继承 GenericTest，存在大量重复代码";          affects="js/modules/Tableware.js, Pathogen.js 等";                   hours="4h";   related="-" },
  @{ id="P2-18"; dir="P2"; file="FIX_P2-18_uiNotificationXss.md";  title="UINotification.show() 使用 innerHTML 存在 XSS 风险";      affects="js/utils/UINotification.js";                                hours="0.5h"; related="P2-20" },
  @{ id="P2-19"; dir="P2"; file="FIX_P2-19_loginGuestLabel.md";    title="login.html 访客按钮描述与实际权限范围不符";               affects="login.html";                                                hours="0.5h"; related="P0-07" },
  @{ id="P2-20"; dir="P2"; file="FIX_P2-20_formValidatorXss.md";   title="FormValidator 缺少 XSS 和 SQL 注入防护规则";              affects="js/utils/FormValidator.js";                                 hours="1h";   related="P2-18" },
  # 文档修复（4项）
  @{ id="DOCS-01"; dir="DOCS"; file="FIX_DOCS-01_backendReadme.md";    title="backend/README.md 仍引用 Supabase，与当前架构完全不符";    affects="backend/README.md";         hours="1h"; related="-" },
  @{ id="DOCS-02"; dir="DOCS"; file="FIX_DOCS-02_apiReference.md";     title="API_REFERENCE.md 端口记录错误（3001/8081 vs 实际 3002/8082）"; affects="docs/API_REFERENCE.md";  hours="2h"; related="-" },
  @{ id="DOCS-03"; dir="DOCS"; file="FIX_DOCS-03_databaseSchema.md";   title="DATABASE_SCHEMA.md 数据库路径与生产配置不一致";             affects="docs/DATABASE_SCHEMA.md";   hours="1h"; related="-" },
  @{ id="DOCS-04"; dir="DOCS"; file="FIX_DOCS-04_missingDocs.md";      title="FRONTEND_GUIDE.md 和 DEPLOYMENT_GUIDE.md 在仓库中缺失";    affects="docs/";                     hours="8h"; related="-" }
)

# ── 优先级标签映射 ────────────────────────────────────────────
function Get-PriorityLabel($id) {
    if     ($id -like "P0*")   { return "🔴 P0 高危（建议 1~3 天内处理）" }
    elseif ($id -like "P1*")   { return "🟠 P1 重要（建议 1 周内处理）" }
    elseif ($id -like "P2*")   { return "🟡 P2 优化（建议 2~3 周内处理）" }
    else                       { return "📄 文档修复（穿插进行）" }
}

# ── 单个修复文档模板 ──────────────────────────────────────────
function New-FixDoc($fix) {
    $priority = Get-PriorityLabel $fix.id
    $content = @"
# FIX-$($fix.id)：$($fix.title)

| 字段 | 内容 |
|------|------|
| **问题 ID** | ``$($fix.id)`` |
| **优先级** | $priority |
| **影响文件** | ``$($fix.affects)`` |
| **预估工时** | $($fix.hours) |
| **关联问题** | $($fix.related) |
| **状态** | ⬜ 待处理 |
| **完成日期** | - |

---

## 1. 问题描述

<!-- 详细描述问题的现象、触发条件、影响范围 -->

> 待填写。

## 2. 根因分析

<!-- 分析问题产生的根本原因，定位到具体代码行 -->

> 待填写。

## 3. 修复方案

### 方案 A（推荐）

<!-- 提供可直接应用的代码 diff 或完整修复代码 -->