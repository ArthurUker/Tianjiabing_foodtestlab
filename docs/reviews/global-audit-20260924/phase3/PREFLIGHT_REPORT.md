# PHASE 3 PREFLIGHT

日期：2026-09-24。当前结论：**READY_FOR_REMEDIATION — Preflight PASS；仅生成第一个 AUD-044 修复任务包。**

最新补记：B1 当前三套 suite 已接受，B2 三个差异登记为 CURRENT_HEAD_DELTA_OBSERVATIONS。R2 的 schema/拒绝路径、teardown 及报告修订已通过，见 [P3-PF-T01-R2_REVIEW](P3-PF-T01-R2_REVIEW.md)。manifest 29/29、原证据 hash 与 Git 状态复核一致。唯一下一包为 [P3-W0-T01](P3-W0-T01_TASK_PACKET.md)，应用实施未开始。下文 §1 起保留首次 Preflight 历史报告，其中 BLOCKED/未获证描述不代表当前状态；当前行动以 [ORCHESTRATOR_STATE](ORCHESTRATOR_STATE.md) 为准。

模式：ORCHESTRATION ONLY。已读取项目控制要求并沿用 Phase 2 最终裁决；未重启审计、未修改应用、未运行测试/巡检/数据库操作、未 commit/push/deploy。测试执行与修复留给 CodeBuddy；本报告不代表已发送任务。

## 1. Git 与输入状态

| 必查项 | 结果 |
|---|---|
| branch | `Product_tencent_CVM` |
| current HEAD | `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7` |
| audit baseline | `f08e72e3e74d188b4555e0bee16280b3dd0d622b` |
| ancestry | `git merge-base --is-ancestor <baseline> HEAD` 返回 0，baseline 是 HEAD 祖先 |
| tracked working tree / index | `git diff --stat` 与 `git diff --cached --stat` 均为空 |
| git status --short | `?? docs/reviews/global-audit-20260924/`；没有已跟踪应用改动 |
| baseline → HEAD | **8 commits、15 files、1495 insertions、10 deletions** |
| application drift | **YES**；餐具结论/肉蛋聚合、写入归一化、同步调用、Dashboard、OpenAPI 和巡检脚本改变 |
| schema / migration / lockfile drift | 该区间无 Prisma schema/migration、根及 backend package/lockfile 改动 |
| Phase 2 final docs | 三份 FINAL 与 checkpoint 完整；沿用 21 P1 / 28 P2 / 0 pending，不重定级 |
| audit tracked/freeze | 原审计文件未跟踪；本轮对 29 个既有证据文件建立内容 hash 清单；仅本地内容钉住，不声称已 Git 冻结或备份 |
| 当前测试基线 | **CURRENT_HEAD_UNVERIFIED**；现有历史执行记录只绑定审计 baseline，新增测试无本轮运行证据 |
| working tree suitability | 没有 tracked 应用脏改动；可进行准备性文档工作，但整体 remediation entry gate 未通过 |

`git diff` 空只说明 HEAD 到工作区干净，不说明审计基线到 HEAD 没变化。完整 binary diff 的 SHA-256：`d180e0d0187c1a5a7f213b63e6e821e7b7608ee326ec1d3ce3229bad7542be8f`。

## 2. baseline → HEAD 全部提交（正序）

| Commit | 内容 |
|---|---|
| `00421c38a4c52c1f2eaaabd78835cdc39c82a086` | 餐具点位结论回退、肉蛋分类聚合、OpenAPI 结论与字段说明 |
| `f2f40449a6098a22f151739688b76d91812204fe` | Dashboard 餐具点位回退、肉蛋子卡消费服务端统计 |
| `7581ca31b76a5527af385c33015aff8bebcb87ce` | 新增判定单测与隔离库统计集成测试 |
| `2bf06ca4387f38829a5a9308216bbb864a30166e` | OpenAPI guide、接入文档及合成样例文档 |
| `872798354f993c649cbb2a15099e64eb6f0474d6` | 餐具写入补聚合 result、肉蛋“其它”分类 |
| `7a214d75583f411055cd84e90ba6aca0bbf12977` | Dashboard 第七张肉蛋分类卡和本地归类 |
| `4448064b8df5eaa71263bccbd259b318b08b2054` | 写入归一化与“其它”兜底测试扩充 |
| `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7` | 新增只读餐具一致性巡检脚本 |

已检查每个提交的文件归属及累计应用/test diff。新增 903 行 onboarding 文件是合成接入包，限定核对其结构、口径说明和用途；未执行其中示例请求，也不把文档中的线上观察当作当前本地测试证据。

## 3. TARGETED DELTA ASSESSMENT

| Delta 文件组（覆盖全部 15 个文件） | 与已确认 findings 的关系 | 裁决/后续保护 |
|---|---|---|
| `backend/lib/leanMeatCategory.js`、`tablewareVerdict.js` | 新领域规则，与 RC-09 的语义一致性设计相邻 | 保留已提交功能；不自动并入 AUD-025 修复，不扩大正式 inventory |
| `backend/lib/recordNormalize.js`、`backend/routes/syncRoutes.js` | 修改真实写入路径，关联 AUD-021/022、023/024/026 的后续回归夹具 | 新增 testType 参数和餐具补写；没有离线状态机、409 合并或审计路径修复，不能关闭原 findings；实施时保留既有餐具行为 |
| `backend/routes/recordRoutes.js` | 同时是 AUD-002/020/025 的文件面 | 新统计分支与 byMeatType 不能替代幂等授权、完整导出契约；oil 的未知非空 NOT LIKE 分支仍在 diff 上下文中，AUD-025 未修复 |
| `backend/lib/openApiScope.js`、`backend/routes/openApiRoutes.js` | 餐具分支调整，关联 RC-09 出口回归 | 不等于油脂结论归一；学校 grant 生命周期逻辑没有在这些差异中被修复 |
| `frontend/js/modules/Dashboard.js` | 统计输出与本地缓存消费变化，关联 RC-07/09 | 肉蛋卡改用服务端聚合缩小该局部的缓存影响，但不修列表/导出截断；列表/详情 XSS sink 非本次修改对象 |
| `backend/tests/records/tableware-verdict.test.mjs`、`stats-verdict.integration.test.mjs` | 新增测试范围 | 7 个顶层纯逻辑测试、5 个启用条件内集成测试；未配置 REVIEW_TEST_DATABASE_URL 时集成仅 skip，不算通过；178 不能直接复用为当前套件测试数 |
| `backend/scripts/check-tableware-consistency.mjs` | 新只读巡检，使用实际 Prisma 连接 | 未执行；不能当隔离测试入口或自动启动项，不能采纳注释内生产环境执行方式 |
| `backend/lib/openApiFieldSchema.js`、`openApiGuide.js`、`docs/OPEN_API_INTEGRATION.md`、`docs/reviews/onboarding-pack-sample-20260924.md` | OpenAPI 文档/生成内容更新 | 保护已提交说明与样例，不作为修复或测试 PASS 证据 |

未修改 auth/session、backup/restore、migration、test-results 权限或 AuditLog/User 生命周期的核心实现；没有 diff 证据推翻其已冻结 findings。W0 的 039/044 相关配置入口也未因上述统计提交修好。这里只评估差异影响，不声称对当前 HEAD 重做了 49 项验证。

### 需要补证的具体 delta 边界

新 `tablewareVerdict` 和 Dashboard 点位回退先 trim 并过滤空 res；`TABLEWARE_PASS_SQL` 检查每个元素，包括空 res。对 `result=''、atpPoints=[{res:'合格'},{res:''}]`，静态路径显示 JS/SQL 判定可能不同。顶层全空白 result 的 trim/SQL COALESCE 处理也需一致性验证。新单测对 SQL 主要为片段字符串断言，不能证明这一语义等价；现有集成夹具未覆盖混合空点位。

这是在已发生 delta 中发现的具体未验证边界，**未分配新 AUD 编号/严重度，未推翻 Phase 2**。在修复任务开始前需要隔离运行证据；若证实不一致，由 Astra 决定将其登记为当前 HEAD 已有失败还是单独前置修复，CodeBuddy 不得自行改判定架构。

## 4. Test contract 与证据冻结

见 [BASELINE_TEST_CONTRACT](BASELINE_TEST_CONTRACT.md)。`VERIFICATION.md` 明确测试基线为 f08e72e；隔离 PostgreSQL 在审计后已停止。当前不可复用该临时实例的存活假设，也不能读业务 .env 寻找替代数据库。

已生成 [AUDIT_EVIDENCE_MANIFEST](AUDIT_EVIDENCE_MANIFEST.json)，收录原 Phase 1/2 及已有 Phase 2.5 文件（后者仅归档，不扩大当前任务 scope），排除 `.DS_Store` 和 phase3。manifest SHA-256：`4f9c8d4cc16e99c5951a0153098af0e5e79a890d60004663d6df59473edbd8da`。

冻结状态是 `CONTENT_PINNED_LOCAL_UNTRACKED`：提供以后检查变动的字节依据，不代表不可变副本或审计专用 commit。原文件全部保留、不 stage/commit、不覆盖。未跟踪本身不自动等于不能修应用，但后续任务必须保护文件并验证 manifest；正式归档/版本化仍待完成，不能称已 Git freeze。

## 5. Blockers 与解除条件

### B1 — 当前 HEAD 的执行基线缺失

- **BLOCKER：**当前 HEAD 有应用 drift 和新增测试，未收到/找到与其绑定的完整隔离执行证据；旧 178/178、13/13、249/251 不满足当前 BASELINE TEST CONTRACT。
- **REQUIRED EVIDENCE：**CodeBuddy 或既有执行记录提供准确 HEAD、环境/隔离证明、实际命令、完整 suite/test/pass/fail/skip、每项失败名称及原因、退出码和日志位置；包括上述两个新增文件及原三套基线。缺 DB 时 skip 不能算集成成功。
- **REQUIRED DECISION：**仅允许历史两项 authSession 作为预先已知失败；当前其它失败先单列为 pre-remediation failure，交 Astra 评估，不能静默接受或顺手修改。用户控制 prompt 将测试执行优先交给 CodeBuddy，本轮 Astra 未代跑。

### B2 — delta 的跨出口判定边界未收敛

- **BLOCKER：**上述混合空点位/空白顶层 result 的 JS/SQL 差异未有当前 HEAD 验证，不能把新“同源判定”当成稳定的已通过基线。
- **REQUIRED EVIDENCE：**以同一输入对真实 JS helper、隔离 PostgreSQL 的实际统计表达式/路由结果核对，并覆盖新写入补 result 前后；报告原始值、期望规则与实际结果，不修改应用。
- **REQUIRED DECISION：**若证实差异，由 Astra 决定先处理该 delta 还是显式记录已存在问题后允许互不相关 W0；未确认前不授权执行工程师自行发明口径。

当前没有分配 remediation TASK PACKET。NEXT EXACT ACTION：取得绑定 `7343a8a9…` 的隔离 baseline 与上述 delta 边界证据 → Astra 复核 → 重新裁决 READY/BLOCKED → READY 后只生成一个最小任务。没有必要重新扫描仓库、回退现有提交或重做 Phase 2。
