# README_DIFF.md — 代码与现有 README 差异表

> 🗄️ **已归档（2026-08-31）**：本文件是 2026-08-24 的一次性差异分析稿，结论已全部并入根目录 `README.md`，
> 并从仓库根目录移入 `docs/archive/`。**其中部分口径已过时**（如后端端口 `3000`，生产实为 **3002**）。
> **以根目录 `README.md` 为唯一权威文档**，本文件仅供过程追溯。

> 生成日期：2026-08-24
> 分析目标：当前工作区 HEAD（已提交代码）+ 用户声明未提交改动
> 唯一事实源：工作区源码（非训练记忆）。每条差异均附 文件:行号/字段 证据。

## 分析范围与覆盖率声明

**已纳入分析**
- 根配置：`package.json`、`package-lock.json`、`jest.config.cjs`、`cypress.config.cjs`、`tailwind.config.cjs`、`.babelrc`
- 后端（全量读取关键模块）：`backend/server.js`、`backend/routes/*`（school/user/audit/session/guest/guest-export-request/sync/adminBackup/schoolBackup/testResult/recognition/frequency/record）、`backend/lib/*`、`backend/modules/*`、`backend/controllers/*`、`backend/middleware`（按需）
- 前端（全量读取关键模块）：`js/modules/registry.js`、`js/core/*`、`js/services/*`、`js/utils/*`、各 Entry HTML
- 部署/脚本：`deploy/`、`scripts/`、`backend/prisma/schema.prisma`
- CI：`.github/workflows/guard-client-branch.yml`
- 现有文档：`README.md`、`TASKS.md`、`docs/**`

**明确跳过（理由）**
- `node_modules/**`：第三方依赖，非项目源码
- `.git/**`：版本库元数据
- `dist/`/`coverage/`/`backups/`/`data/`：构建/测试产物与运行期数据
- `vendor/**`：vendored 第三方库（5 个 .js）
- `docs/*.png`（32 张）：二进制资源，仅读 .md/.json/.html
- `backend/prisma/migrations/` 历史迁移脚本：仅读 `schema.prisma` 当前权威模型

**覆盖率**：根配置 100%；后端路由层 100%（12 个路由文件全部读取）；前端模块注册中心与核心层 100%；部署/CI 已读取。个别历史 `docs/*.md` 未逐篇读，但不影响 README 差异判定。

---

## 差异汇总表

| # | README 原表述 | 代码事实 | 差异类型 | 证据来源 | 风险 |
|---|---|---|---|---|---|
| D1 | §1.1（旧第48行）："后端 `/api/recognize` 路由**已实现但暂未在 `server.js` 挂载启用**…属已知待启用项（见 §10）" | `server.js:311` 已 `app.use('/api', recognitionRoutes)`；`recognitionRoutes.js` 定义 `POST /recognize`、`GET /recognize/status/:jobId`；模块加载时 `recognitionQueue` 自动 pump | **不符（错误断言）** | `server.js:311`、`backend/routes/recognitionRoutes.js:1-30`、`backend/modules/recognitionQueue.js` | 高 |
| D2 | §10.2：`TD-Recognition-Mount` 待办："尚未在 `server.js` 中 `app.use` 挂载…需挂载后方可开放" | 同 D1，路由已挂载，该待办项前提不成立 | **不符（基于错误前提）** | 同上 | 高 |
| D3 | §5 API 文档缺少 `/api/recognize*` 端点小节 | 后端已提供 `POST /api/recognize` 与 `GET /api/recognize/status/:jobId`（已挂载、需登录） | **缺失** | `backend/routes/recognitionRoutes.js`、`server.js:311` | 中 |
| D4 | 文首同步状态注记："标注尚未启用的能力" | 无"待启用"能力需标注（recognition 已启用） | **不符（措辞失真）** | `server.js:311` | 低 |
| D5 | §2 技术栈："Node.js 20（NVM）"；§10.1 TD-Naming："`engines.node` 对齐 `>=18`" | `package.json` 实际 `engines.node=">=18.0.0"`；运行说明用 NVM 装 20 | 一致（措辞混合版本号与运行建议，非矛盾） | `package.json#engines.node` | 低 |
| D6 | §5.5 审计日志表（旧）：仅列出 audit-logs 基础端点 | `auditRoutes.js` 实际还提供 `GET /api/audit-logs/users`、`GET /api/audit-logs/school/:schoolCode`、`GET /api/audit-logs/school/:schoolCode/date-range`，且 `GET /` 支持 `startDate/endDate/userId/username/action` 筛选 | 一致（已在上一轮更新中补充，本次复核确认与代码吻合） | `backend/routes/auditRoutes.js` | 低 |
| D7 | §5.7 检测频率端点 | `frequencyRoutes.js` 提供 `/overview`、`/thresholds`(GET/PUT)、`/calendar`(GET/PUT)、`/today`，与 §5.7 表一致 | 一致 | `backend/routes/frequencyRoutes.js` | 低 |
| D8 | §5.3 访客端点路径（`/api/guest-export-request/*`） | `server.js:289` `app.use('/api/guest-export-request', guestExportRequestRoutes)` 存在；`guestRoutes.js` 另提供 `/api/guest/register|login|verify-token|quick-access|stats` | 一致（两套并存，README 描述准确） | `server.js:289`、`backend/routes/guestRoutes.js` | 低 |
| D9 | §7.2："首登强制改密 `must_change_password=true`…服务端 403" | `userModel`/`authenticateUser` 强制；`User.must_change_password` 字段存在 | 一致 | `backend/prisma/schema.prisma#User`、`backend/middleware/authenticate*` | 低 |
| D10 | §9 安全：CORS 白名单、JWT 弱口令拒绝启动 | `server.js` 已禁止 `*` 通配符（`allowAllOrigins` 校验）、`detectController` 弱口令黑名单拦截启动 | 一致 | `backend/server.js#CORS 段`、`backend/controllers/detectController.js` | 低 |
| D11 | §11.1 环境变量与 scripts 命令 | 全部命令在 `package.json#scripts` 有定义；环境变量在 `server.js`/`config` 读取处有证据 | 一致 | `package.json#scripts`、`backend/server.js` 顶部 env 读取 | 低 |

---

## 结论

- **高风险的真实差异只有 D1、D2**（均源自上一轮更新时我误判 `/api/recognize` 未挂载）。已据 `server.js:311` 证据在 README 中修正：删除"未挂载/待启用"断言，并新增 §5.11 将端点正式列入 API 文档（D3）。
- D4 随 D1/D2 一并修正。
- 其余条目（D5–D11）经逐条核对，**README 与代码一致**，无需改动。
- 无"待确认"项需要进入 README_REVIEW（所有结论均有代码证据支撑）；仅保留常规人工复核清单。
