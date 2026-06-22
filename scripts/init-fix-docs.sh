#!/usr/bin/env bash
# ============================================================
# init-fix-docs.sh
# 自动生成 docs/fix/ 下所有修复文档骨架（56个文件）
# 适用：macOS / Linux（bash/zsh）
#
# 用法（在项目根目录执行）：
#   bash ./scripts/init-fix-docs.sh
# ============================================================

set -e  # 任何命令失败立即退出

# ── 路径定义 ─────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BASE_DIR="$ROOT_DIR/docs/fix"

# ── 颜色输出 ─────────────────────────────────────────────────
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
GRAY='\033[0;37m'
NC='\033[0m' # No Color

echo ""
echo -e "${YELLOW}🚀 开始生成修复文档骨架...${NC}"
echo -e "${GRAY}📁 输出目录: $BASE_DIR${NC}"
echo ""

# ── 创建目录结构 ──────────────────────────────────────────────
for dir in "$BASE_DIR" "$BASE_DIR/P0" "$BASE_DIR/P1" "$BASE_DIR/P2" "$BASE_DIR/DOCS"; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    echo -e "  ${GREEN}📂 创建目录: ${dir#$ROOT_DIR/}${NC}"
  fi
done

# ── 单个修复文档生成函数 ──────────────────────────────────────
make_doc() {
  local id="$1"
  local subdir="$2"
  local filename="$3"
  local title="$4"
  local affects="$5"
  local hours="$6"
  local related="$7"

  # 优先级标签
  case "$id" in
    P0*) priority="🔴 P0 高危（建议 1~3 天内处理）" ;;
    P1*) priority="🟠 P1 重要（建议 1 周内处理）" ;;
    P2*) priority="🟡 P2 优化（建议 2~3 周内处理）" ;;
    *)   priority="📄 文档修复（穿插进行）" ;;
  esac

  local filepath="$BASE_DIR/$subdir/$filename"

  cat > "$filepath" <<EOF
# FIX-${id}：${title}

| 字段 | 内容 |
|------|------|
| **问题 ID** | \`${id}\` |
| **优先级** | ${priority} |
| **影响文件** | \`${affects}\` |
| **预估工时** | ${hours} |
| **关联问题** | ${related} |
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

\`\`\`diff
// 待填写
\`\`\`

### 方案 B（备选）

> 暂无备选方案。

## 4. 验收标准

- [ ] 验收条件 1
- [ ] 验收条件 2
- [ ] 验收条件 3

## 5. 回归测试要点

- [ ] 测试点 1
- [ ] 测试点 2

## 6. 备注

> 无。
EOF

  echo -e "  ${CYAN}📄 生成: docs/fix/${subdir}/${filename}${NC}"
}

# ── P0 高危（9项）────────────────────────────────────────────
make_doc "P0-01" "P0" "FIX_P0-01_syncRoutes.md"        "syncRoutes.js 无认证 + 不操作DB + CommonJS 三重问题"         "backend/routes/syncRoutes.js"                               "4h"   "P1-16"
make_doc "P0-02" "P0" "FIX_P0-02_authMiddleware.md"    "authenticateUser 中间件三处实现不一致"                       "backend/server.js, userRoutes.js, auditRoutes.js"           "3h"   "P0-01, P0-04"
make_doc "P0-03" "P0" "FIX_P0-03_jwtSecret.md"         "JWT 密钥 fallback 为弱明文字符串"                           "backend/server.js"                                          "0.5h" "-"
make_doc "P0-04" "P0" "FIX_P0-04_registerEndpoint.md"  "POST /api/user/register 完全公开无需授权"                   "backend/routes/userRoutes.js"                               "0.5h" "P0-02"
make_doc "P0-05" "P0" "FIX_P0-05_seedPassword.md"      "seed.js 初始密码明文写入公开仓库"                           "backend/prisma/seed.js + 生产环境账号"                      "1h"   "P2-12"
make_doc "P0-06" "P0" "FIX_P0-06_recordCode.md"        "record_code 双重生成逻辑导致幂等性失效"                     "backend/server.js, backend/prisma/schema.prisma"            "3h"   "P1-15"
make_doc "P0-07" "P0" "FIX_P0-07_quickAccess.md"       "快速访问模式完全绕过后端认证"                               "js/services/GuestAuthService.js, login.html"                "4h"   "P1-18, P2-19"
make_doc "P0-08" "P0" "FIX_P0-08_storageHeaders.md"    "Storage.js _getHeaders() Token 注入机制待确认"              "js/core/Storage.js"                                         "1h"   "P1-14"
make_doc "P0-09" "P0" "FIX_P0-09_authVerify.md"        "auth.verify() 对编辑操作完全不做权限校验"                   "js/core/Auth.js, Tableware.js, GenericTest.js, Pathogen.js" "3h"   "P1-21"

# ── P1 重要（23项）───────────────────────────────────────────
make_doc "P1-01" "P1" "FIX_P1-01_auditRouteOrder.md"   "auditRoutes.js 路由注册顺序冲突"                            "backend/routes/auditRoutes.js"                              "0.5h" "P2-15"
make_doc "P1-02" "P1" "FIX_P1-02_idempotencyMemory.md" "幂等性中间件使用内存存储，PM2重启后全部失效"                "backend/middleware/idempotencyMiddleware.js"                 "2h"   "-"
make_doc "P1-03" "P1" "FIX_P1-03_fakeEmail.md"         "UserManager 注册时自动生成虚假 email"                       "backend/modules/UserManager.js"                             "0.5h" "-"
make_doc "P1-04" "P1" "FIX_P1-04_passwordStrength.md"  "密码强度校验过弱（仅要求 length >= 6）"                     "backend/modules/UserManager.js"                             "1h"   "-"
make_doc "P1-05" "P1" "FIX_P1-05_refreshToken.md"      "AuthService.refreshToken() 调用后端不存在的接口"            "js/services/AuthService.js, backend/routes/userRoutes.js"  "2h"   "-"
make_doc "P1-06" "P1" "FIX_P1-06_cssPermission.md"     "前端权限控制完全依赖 CSS hidden，可被 DevTools 绕过"        "js/core/Router.js, 各业务模块"                              "3h"   "P0-09"
make_doc "P1-07" "P1" "FIX_P1-07_windowRouter.md"      "Router.js 将自身暴露到 window.router 全局作用域"           "js/core/Router.js"                                          "0.5h" "P2-10"
make_doc "P1-08" "P1" "FIX_P1-08_cascadeDelete.md"     "TestRecord 的 onDelete:Cascade 可能导致数据意外丢失"        "backend/prisma/schema.prisma"                               "1h"   "-"
make_doc "P1-09" "P1" "FIX_P1-09_auditDualSystem.md"   "两套并行审计日志机制并存，职责边界混乱"                     "js/utils/AuditLogger.js, js/services/AuditLogService.js"   "2h"   "-"
make_doc "P1-10" "P1" "FIX_P1-10_permissionCache.md"   "PermissionService 权限缓存永不失效"                         "js/services/PermissionService.js"                           "1h"   "-"
make_doc "P1-11" "P1" "FIX_P1-11_sessionManager.md"    "SessionManager 会话全存内存且 IP 硬编码"                    "js/services/SessionManager.js"                              "2h"   "-"
make_doc "P1-12" "P1" "FIX_P1-12_telemetryCommonJS.md" "telemetry.js 使用 CommonJS 且未集成到主进程"               "backend/config/telemetry.js"                                "1h"   "-"
make_doc "P1-13" "P1" "FIX_P1-13_corsOrigin.md"        "CORS_ORIGIN 配置在代码与环境变量间不一致"                   "backend/server.js, .env.example"                            "0.5h" "-"
make_doc "P1-14" "P1" "FIX_P1-14_storageCache.md"      "Storage.getAll() 优先返回本地缓存，数据一致性无保障"        "js/core/Storage.js"                                         "2h"   "P0-08"
make_doc "P1-15" "P1" "FIX_P1-15_dedupeRoot.md"        "生产环境重复数据根因未根治"                                 "backend/server.js, schema.prisma"                           "1h"   "P0-06"
make_doc "P1-16" "P1" "FIX_P1-16_backupRestore.md"     "BackupRestore.js 备份恢复依赖无效的 syncRoutes"             "js/modules/BackupRestore.js"                                "2h"   "P0-01"
make_doc "P1-17" "P1" "FIX_P1-17_userMgmtDelete.md"    "UserManagement 删除操作无二次确认且无后端权限校验"          "js/modules/UserManagement.js"                               "1h"   "-"
make_doc "P1-18" "P1" "FIX_P1-18_pathogenGuest.md"     "访客可访问病原体检测模块，与权限矩阵矛盾"                   "js/modules/Pathogen.js"                                     "0.5h" "P0-07"
make_doc "P1-19" "P1" "FIX_P1-19_fingerprintEvict.md"  "AdaptiveUploadQueue 指纹缓存淘汰策略未确认"                 "js/core/AdaptiveUploadQueue.js"                             "1h"   "-"
make_doc "P1-20" "P1" "FIX_P1-20_dashboardGlobal.md"   "Dashboard.js 全局函数挂载 + 5个StorageService实例"         "js/modules/Dashboard.js"                                    "2h"   "P2-10"
make_doc "P1-21" "P1" "FIX_P1-21_authClassRename.md"   "Auth.js 与 AuthService.js 类名完全相同导致混淆"             "js/core/Auth.js"                                            "1h"   "P0-09"
make_doc "P1-22" "P1" "FIX_P1-22_sampleDataId.md"      "SampleDataGenerator 示例数据 ID 格式与 StorageService 不兼容" "js/utils/SampleDataGenerator.js"                         "1h"   "-"
make_doc "P1-23" "P1" "FIX_P1-23_validatorSync.md"     "前端 FormValidator 校验规则与后端 validationMiddleware 不同步" "js/utils/FormValidator.js, validationMiddleware.js"      "2h"   "-"

# ── P2 优化（20项）───────────────────────────────────────────
make_doc "P2-01" "P2" "FIX_P2-01_rateLimit.md"             "登录接口无专项限流，默认限流阈值过高"                   "backend/server.js"                                          "0.5h" "-"
make_doc "P2-02" "P2" "FIX_P2-02_auditCrud.md"             "检测记录 CRUD 操作未在后端层自动写入审计日志"           "backend/server.js"                                          "2h"   "P1-09"
make_doc "P2-03" "P2" "FIX_P2-03_failedLoginLog.md"        "失败登录日志未确认写入数据库"                           "backend/modules/UserManager.js"                             "0.5h" "-"
make_doc "P2-04" "P2" "FIX_P2-04_jsonParseSafe.md"         "AuthService.getUser() JSON.parse 无容错处理"            "js/services/AuthService.js"                                 "0.5h" "-"
make_doc "P2-05" "P2" "FIX_P2-05_guestAuthSingleton.md"    "Router.init() 每次调用都实例化新的 GuestAuthService"    "js/core/Router.js"                                          "0.5h" "-"
make_doc "P2-06" "P2" "FIX_P2-06_healthDuplicate.md"       "/api/health 与 /health 重复定义"                        "backend/server.js"                                          "0.5h" "-"
make_doc "P2-07" "P2" "FIX_P2-07_recordSchemaValidation.md" "buildRecordWriteData() 字段提取无 Schema 验证"         "backend/server.js"                                          "2h"   "-"
make_doc "P2-08" "P2" "FIX_P2-08_backupForeignKey.md"      "Backup 模型缺少关联用户外键约束"                        "backend/prisma/schema.prisma"                               "1h"   "-"
make_doc "P2-09" "P2" "FIX_P2-09_networkHelperUrl.md"      "NetworkHelper 硬编码 Google URL，内网环境不可达"        "js/utils/NetworkHelper.js"                                  "0.5h" "-"
make_doc "P2-10" "P2" "FIX_P2-10_windowGlobal.md"          "main.js 和 Dashboard.js 大量函数通过 window.* 全局暴露" "js/main.js, js/modules/Dashboard.js"                       "2h"   "P1-07, P1-20"
make_doc "P2-11" "P2" "FIX_P2-11_guestJsonParse.md"        "GuestAuthService.getCurrentGuest() JSON.parse 无容错"  "js/services/GuestAuthService.js"                            "0.5h" "P2-04"
make_doc "P2-12" "P2" "FIX_P2-12_seedProdAccounts.md"      "seed.js 测试账号在生产环境应禁用"                       "backend/prisma/seed.js"                                     "0.5h" "P0-05"
make_doc "P2-13" "P2" "FIX_P2-13_tempIdCollision.md"       "tempId 使用 Date.now()+Math.random()，多标签页可能碰撞" "js/core/Storage.js"                                         "1h"   "-"
make_doc "P2-14" "P2" "FIX_P2-14_exportStaleData.md"       "ExportService 导出数据完全来自本地缓存，可能过期"       "js/services/ExportService.js"                               "1h"   "P1-14"
make_doc "P2-15" "P2" "FIX_P2-15_auditStatsRoute.md"       "AuditLogService.getStats() 路由路径与 P1-01 冲突"       "js/services/AuditLogService.js"                             "0h"   "P1-01"
make_doc "P2-16" "P2" "FIX_P2-16_mammothSri.md"            "Pathogen.js 动态加载 Mammoth.js 无 SRI 完整性校验"      "js/modules/Pathogen.js"                                     "0.5h" "-"
make_doc "P2-17" "P2" "FIX_P2-17_genericTestInherit.md"    "各检测模块未继承 GenericTest，存在大量重复代码"         "js/modules/Tableware.js, Pathogen.js 等"                    "4h"   "-"
make_doc "P2-18" "P2" "FIX_P2-18_uiNotificationXss.md"     "UINotification.show() 使用 innerHTML 存在 XSS 风险"     "js/utils/UINotification.js"                                 "0.5h" "P2-20"
make_doc "P2-19" "P2" "FIX_P2-19_loginGuestLabel.md"       "login.html 访客按钮描述与实际权限范围不符"              "login.html"                                                 "0.5h" "P0-07"
make_doc "P2-20" "P2" "FIX_P2-20_formValidatorXss.md"      "FormValidator 缺少 XSS 和 SQL 注入防护规则"             "js/utils/FormValidator.js"                                  "1h"   "P2-18"

# ── 文档修复（4项）───────────────────────────────────────────
make_doc "DOCS-01" "DOCS" "FIX_DOCS-01_backendReadme.md"  "backend/README.md 仍引用 Supabase，与当前架构完全不符"          "backend/README.md"       "1h" "-"
make_doc "DOCS-02" "DOCS" "FIX_DOCS-02_apiReference.md"   "API_REFERENCE.md 端口记录错误（3001/8081 vs 实际 3002/8082）"   "docs/API_REFERENCE.md"   "2h" "-"
make_doc "DOCS-03" "DOCS" "FIX_DOCS-03_databaseSchema.md" "DATABASE_SCHEMA.md 数据库路径与生产配置不一致"                  "docs/DATABASE_SCHEMA.md" "1h" "-"
make_doc "DOCS-04" "DOCS" "FIX_DOCS-04_missingDocs.md"    "FRONTEND_GUIDE.md 和 DEPLOYMENT_GUIDE.md 在仓库中缺失"         "docs/"                   "8h" "-"

# ── 生成 FIX_PLAN.md ─────────────────────────────────────────
cat > "$BASE_DIR/FIX_PLAN.md" <<'PLAN'
# 食品安全检验管理系统 Pro — 修复计划总进度看板

**文档路径**：`docs/fix/FIX_PLAN.md`
**基于审阅版本**：REVIEW_GUIDE.md v0.6
**计划制定日期**：2026-06-22
**文档版本**：v1.0

> 本文件为修复工作的**总索引和进度看板**。
> 每个问题的详细描述、修复代码、验收标准见对应子文件。

---

## 目录结构

```
docs/fix/
├── FIX_PLAN.md          ← 本文件（总进度看板）
├── P0/                  ← 高危问题（9项）
├── P1/                  ← 重要问题（23项）
├── P2/                  ← 优化建议（20项）
└── DOCS/                ← 文档修复（4项）
```

---

## 关键依赖关系

```
P0-02（统一 authMiddleware）
    └─► P0-01（syncRoutes 重写）
            └─► P1-16（BackupRestore 修复）

P0-06（record_code 统一）
    └─► P1-15（重复数据根治）

P1-01（路由顺序修复）
    └─► P2-15（自动解决）

P0-07（快速访问认证修复）
    └─► P1-18（病原体访客权限）
            └─► P2-19（login.html 描述更新）

P1-21（Auth.js 重命名）
    └─► P0-09（auth.verify() 权限校验）
```

---

## 执行路线图

| 阶段 | 时间 | 目标 |
|------|------|------|
| 第一阶段 | Day 1~3 | 消除所有 P0 安全漏洞 |
| 第二阶段 | Week 1  | 修复 P1 功能正确性问题 |
| 第三阶段 | Week 2  | 完成 P1 架构优化 |
| 第四阶段 | Week 3  | P2 优化 + 文档修复 |

---

## P0 高危问题（9项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `P0-01` | syncRoutes.js 无认证 + 不操作DB + CommonJS 三重问题 | 4h | ⬜ 待处理 | - |
| `P0-02` | authenticateUser 中间件三处实现不一致 | 3h | ⬜ 待处理 | - |
| `P0-03` | JWT 密钥 fallback 为弱明文字符串 | 0.5h | ⬜ 待处理 | - |
| `P0-04` | POST /api/user/register 完全公开无需授权 | 0.5h | ⬜ 待处理 | - |
| `P0-05` | seed.js 初始密码明文写入公开仓库 | 1h | ⬜ 待处理 | - |
| `P0-06` | record_code 双重生成逻辑导致幂等性失效 | 3h | ⬜ 待处理 | - |
| `P0-07` | 快速访问模式完全绕过后端认证 | 4h | ⬜ 待处理 | - |
| `P0-08` | Storage.js _getHeaders() Token 注入机制待确认 | 1h | ⬜ 待处理 | - |
| `P0-09` | auth.verify() 对编辑操作完全不做权限校验 | 3h | ⬜ 待处理 | - |

---

## P1 重要问题（23项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `P1-01` | auditRoutes.js 路由注册顺序冲突 | 0.5h | ⬜ 待处理 | - |
| `P1-02` | 幂等性中间件使用内存存储，PM2重启后全部失效 | 2h | ⬜ 待处理 | - |
| `P1-03` | UserManager 注册时自动生成虚假 email | 0.5h | ⬜ 待处理 | - |
| `P1-04` | 密码强度校验过弱（仅要求 length >= 6） | 1h | ⬜ 待处理 | - |
| `P1-05` | AuthService.refreshToken() 调用后端不存在的接口 | 2h | ⬜ 待处理 | - |
| `P1-06` | 前端权限控制完全依赖 CSS hidden，可被 DevTools 绕过 | 3h | ⬜ 待处理 | - |
| `P1-07` | Router.js 将自身暴露到 window.router 全局作用域 | 0.5h | ⬜ 待处理 | - |
| `P1-08` | TestRecord 的 onDelete:Cascade 可能导致数据意外丢失 | 1h | ⬜ 待处理 | - |
| `P1-09` | 两套并行审计日志机制并存，职责边界混乱 | 2h | ⬜ 待处理 | - |
| `P1-10` | PermissionService 权限缓存永不失效 | 1h | ⬜ 待处理 | - |
| `P1-11` | SessionManager 会话全存内存且 IP 硬编码 | 2h | ⬜ 待处理 | - |
| `P1-12` | telemetry.js 使用 CommonJS 且未集成到主进程 | 1h | ⬜ 待处理 | - |
| `P1-13` | CORS_ORIGIN 配置在代码与环境变量间不一致 | 0.5h | ⬜ 待处理 | - |
| `P1-14` | Storage.getAll() 优先返回本地缓存，数据一致性无保障 | 2h | ⬜ 待处理 | - |
| `P1-15` | 生产环境重复数据根因未根治 | 1h | ⬜ 待处理 | - |
| `P1-16` | BackupRestore.js 备份恢复依赖无效的 syncRoutes | 2h | ⬜ 待处理 | - |
| `P1-17` | UserManagement 删除操作无二次确认且无后端权限校验 | 1h | ⬜ 待处理 | - |
| `P1-18` | 访客可访问病原体检测模块，与权限矩阵矛盾 | 0.5h | ⬜ 待处理 | - |
| `P1-19` | AdaptiveUploadQueue 指纹缓存淘汰策略未确认 | 1h | ⬜ 待处理 | - |
| `P1-20` | Dashboard.js 全局函数挂载 + 5个StorageService实例 | 2h | ⬜ 待处理 | - |
| `P1-21` | Auth.js 与 AuthService.js 类名完全相同导致混淆 | 1h | ⬜ 待处理 | - |
| `P1-22` | SampleDataGenerator 示例数据 ID 格式与 StorageService 不兼容 | 1h | ⬜ 待处理 | - |
| `P1-23` | 前端 FormValidator 校验规则与后端 validationMiddleware 不同步 | 2h | ⬜ 待处理 | - |

---

## P2 优化建议（20项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `P2-01` | 登录接口无专项限流，默认限流阈值过高 | 0.5h | ⬜ 待处理 | - |
| `P2-02` | 检测记录 CRUD 操作未在后端层自动写入审计日志 | 2h | ⬜ 待处理 | - |
| `P2-03` | 失败登录日志未确认写入数据库 | 0.5h | ⬜ 待处理 | - |
| `P2-04` | AuthService.getUser() JSON.parse 无容错处理 | 0.5h | ⬜ 待处理 | - |
| `P2-05` | Router.init() 每次调用都实例化新的 GuestAuthService | 0.5h | ⬜ 待处理 | - |
| `P2-06` | /api/health 与 /health 重复定义 | 0.5h | ⬜ 待处理 | - |
| `P2-07` | buildRecordWriteData() 字段提取无 Schema 验证 | 2h | ⬜ 待处理 | - |
| `P2-08` | Backup 模型缺少关联用户外键约束 | 1h | ⬜ 待处理 | - |
| `P2-09` | NetworkHelper 硬编码 Google URL，内网环境不可达 | 0.5h | ⬜ 待处理 | - |
| `P2-10` | main.js 和 Dashboard.js 大量函数通过 window.* 全局暴露 | 2h | ⬜ 待处理 | - |
| `P2-11` | GuestAuthService.getCurrentGuest() JSON.parse 无容错 | 0.5h | ⬜ 待处理 | - |
| `P2-12` | seed.js 测试账号在生产环境应禁用 | 0.5h | ⬜ 待处理 | - |
| `P2-13` | tempId 使用 Date.now()+Math.random()，多标签页可能碰撞 | 1h | ⬜ 待处理 | - |
| `P2-14` | ExportService 导出数据完全来自本地缓存，可能过期 | 1h | ⬜ 待处理 | - |
| `P2-15` | AuditLogService.getStats() 路由路径与 P1-01 冲突 | 0h | ⬜ 待处理 | - |
| `P2-16` | Pathogen.js 动态加载 Mammoth.js 无 SRI 完整性校验 | 0.5h | ⬜ 待处理 | - |
| `P2-17` | 各检测模块未继承 GenericTest，存在大量重复代码 | 4h | ⬜ 待处理 | - |
| `P2-18` | UINotification.show() 使用 innerHTML 存在 XSS 风险 | 0.5h | ⬜ 待处理 | - |
| `P2-19` | login.html 访客按钮描述与实际权限范围不符 | 0.5h | ⬜ 待处理 | - |
| `P2-20` | FormValidator 缺少 XSS 和 SQL 注入防护规则 | 1h | ⬜ 待处理 | - |

---

## 文档修复（4项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `DOCS-01` | backend/README.md 仍引用 Supabase，与当前架构完全不符 | 1h | ⬜ 待处理 | - |
| `DOCS-02` | API_REFERENCE.md 端口记录错误（3001/8081 vs 实际 3002/8082） | 2h | ⬜ 待处理 | - |
| `DOCS-03` | DATABASE_SCHEMA.md 数据库路径与生产配置不一致 | 1h | ⬜ 待处理 | - |
| `DOCS-04` | FRONTEND_GUIDE.md 和 DEPLOYMENT_GUIDE.md 在仓库中缺失 | 8h | ⬜ 待处理 | - |

---

## 工时汇总

| 类别 | 数量 | 预估工时 |
|------|------|---------|
| P0 高危 | 9项 | ~20h |
| P1 重要 | 23项 | ~31h |
| P2 优化 | 20项 | ~19.5h |
| 文档修复 | 4项 | ~12h |
| **合计** | **56项** | **~82.5h** |
PLAN

echo -e "  ${CYAN}📄 生成: docs/fix/FIX_PLAN.md${NC}"

# ── 完成提示 ─────────────────────────────────────────────────
echo ""
echo -e "${GREEN}✅ 完成！共生成 56 个修复文档 + 1 个总进度看板${NC}"
echo ""
echo -e "${YELLOW}📋 目录结构：${NC}"
echo -e "   docs/fix/FIX_PLAN.md"
echo -e "   docs/fix/P0/   → 9  个文件"
echo -e "   docs/fix/P1/   → 23 个文件"
echo -e "   docs/fix/P2/   → 20 个文件"
echo -e "   docs/fix/DOCS/ → 4  个文件"
echo ""
echo -e "${YELLOW}🔜 下一步：${NC}"
echo -e "${GRAY}   git add docs/fix/${NC}"
echo -e "${GRAY}   git commit -m 'docs: 初始化修复文档骨架（56个问题）'${NC}"
echo -e "${GRAY}   git push origin ZhuHaiYiZhong${NC}"
echo ""