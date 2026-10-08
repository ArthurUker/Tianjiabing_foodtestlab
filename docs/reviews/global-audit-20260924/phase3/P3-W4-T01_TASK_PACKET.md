# CodeBuddy TASK PACKET — P3-W4-T01（并行包 B：客户端同步语义，RC-01+RC-06）

## 任务与固定边界

修复 **AUD-001 / AUD-021 / AUD-022**（全部 CONFIRMED_P1）。依据：`phase2/ROOT_CAUSE_MATRIX.md` RC-01、RC-06；`phase2/REMEDIATION_DEPENDENCY_GRAPH.md` W4；`phase2/BATCH-C-VERIFICATION.md` 状态机证据。

**⚠️ 并行执行**：本包与 P3-W3-T01、P3-W5-T01 在**同一工作树**并发执行。规则：
1. 只改本包授权文件与新建文件；兄弟包文件绝不修改/还原（快照已标 `PARALLEL_OTHER_PACKET_SCOPE_DO_NOT_TOUCH`）。
2. **共享文件** `backend/routes/recordRoutes.js`（922 行）：**只许改 `:480` 至文件尾的 sync/409 区**（AUD-022 的 409 响应扩展与 stale 重放拒绝）；**`:1-300` 的统计 SQL 区属 P3-W5-T01**，中间 `:301-479` 为缓冲区谁都别动。每次编辑前重读文件、只用带上下文的定点替换、**绝不整文件重排/格式化**。
3. **禁止运行全套件**；只跑本包定点测试。不 reset/clean/stash/stage/commit/push。固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`。
4. 先读 `ORCHESTRATOR_STATE.md`、本包、`P3-W4-T01_REVIEW_INPUT_MANIFEST.json`（616 项）；非兄弟、非授权 drift 先报告。

## 允许修改（仅此）

- `frontend/js/core/Storage.js`（906 行）、`frontend/js/core/AdaptiveUploadQueue.js`（325 行）
- `backend/routes/recordRoutes.js` **仅 :480-末尾**（sync/409 区）
- 可在 `frontend/js/core/` 新建同步状态机模块；可在 `tests/` 新建本包专用 `w4-*.test.js`（root Jest/jsdom）或 `backend/tests/sync/` node:test 套件；新证据只写 `phase3/evidence/P3-W4-T01/`

## 总控设计口径（源自 RC-01/RC-06，不另行发挥）

1. **缓存/队列作用域**（AUD-001）：本地缓存与离线队列键统一为 `tenant + subject + resource` 作用域（学校 code + 用户标识）；旧键**一次性迁移或显式丢弃并记录**（不得静默双读）；跨主体读取须有回归证明为 0 命中。
2. **同步状态机**（AUD-021）：客户端唯一写入路径经显式状态机（TEMP_CREATED → EDITING_PENDING → SYNCING → SYNCED/FAILED/CONFLICT/DELETED）；create 出队后的编辑不得静默丢失（合并进在途 create 或转为 update 任务）；删除后不得复活为幽灵行。本地队列结构变更需版本化 + 一次性迁移。
3. **409 并发协议**（AUD-022）：服务端 PUT 保持 CAS，409 响应体**扩展冲突信息**（latest 对象或字段级基线；**向后兼容**：旧客户端忽略新字段=安全失败而非误重试）；客户端收到 409 **禁止自动全量重放**——字段基线三路合并（base/server/local）或显式冲突态请用户处理；stale 全量重放必须被服务端识别并拒绝。
4. 不引入 schema 变更；不改认证/授权语义（W1 范围）；不碰 `recordRoutes.js:20-21` 的中间件顺序（AUD-002 不在本包）。

## 退出条件

- 定点测试：① 跨租户/跨主体缓存命中矩阵（A/B 校 × 角色，命中=0）；② 状态机时序矩阵（离线建→改→删→重连、在途编辑、失败重试、删除不复活）；③ 两客户端并发（A 改 X、B 改 Y 均保留；同改 X → 一方得 409+冲突信息，**无静默覆盖**）；④ stale 全量重放被识别拒绝；⑤ 旧客户端兼容负例（忽略新字段=明确失败而非误成功）。
- 服务端 409 扩展须有真实 HTTP 或定点路由测试；客户端状态机用 jsdom/合成 fetch 测试；逐入口真实 rc/原始日志。
- 证据 `evidence/P3-W4-T01/`：RESULT.md、COMMANDS.md、TEST_RESULTS.json、输入对照（本包范围 + 兄弟 drift 豁免）、冻结 29 只读核验、`HASHES_FINAL.json`（两次只读复验）。不运行旧 PF 校验器。**不跑全套件**，RESULT 明确「全套件回归留待三合一轮次」。

## 返回

STATUS（仅 W4-T01）、CHANGED FILES（含 recordRoutes.js 改动行区声明）、定点 rc、四组判别证据、hash/Git、DESIGN BLOCKER（如有）、未决项、ASTRA REVIEW HANDOFF，然后停止。
