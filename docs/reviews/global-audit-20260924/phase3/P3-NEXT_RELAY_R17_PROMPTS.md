# R17 下一轮：三项独占定点返工，然后 CLOSE-B 干净复跑

前三窗可同时发放，各用自有实例且文件面不交叉。第四份待前三窗明文停止、总控复核后再发。旧 P3-CLOSE-B-R3 红链与全部 HASHES 保留。

## 窗口 F：fixture 与 live-api 合同（B-1/B-2/B-3）

```text
执行 P3-FIXTURE-CONTRACT-R4。先读 docs/AI_review/Codex-GPT6/P3-CLOSE-B-R17_REVIEW.md、evidence/P3-CLOSE-B-R3/{RESULT.md,BLOCKERS.md} 及原始 S1/S4/S5/S7 日志。只编辑 tests/isolation/t02b-root-fixture.cjs、backend/tests/t02c-instance-fixture.mjs、backend/tests/report-auth/report-auth-fixture.mjs、tests/integration/live-api.mjs、backend/tests/t02c-live-api-harness.mjs 与本包新测试/证据；不改产品、迁移、schema/client、其它窗口测试及旧证据。

B-1：migration-first 下 School.id 非空且无 DB 默认，fixture 插学校须显式给稳定有效 id；既有 school 行走幂等核对，不篡改身份。证明在已回放 16 链实例上 T02B fixture 成功并产出 T02B_FIXTURE_FILE，root DB Jest 11/11；也证明在空 school 行但已迁移 public 下不会先造租户合成 User 污染链。不能以手写 SQL 绕过 fixture。

B-2：两处受限角色 AuditLog INSERT 必须满足 M2 的 principal_id、FK 与 G3 主体语义。若 user_id 为 manager，绑定该 manager 在同 schema 的 kind=user 主体；若选系统事件，则 user_id 与 actor_snapshot 语义均为空并绑定 kind=system，不能把 system principal 与 manager user_id 混用。保留真实受限角色 SELECT/INSERT/UPDATE/DELETE、事务回滚零残留和 public 探针；T02E 与 report-auth fixture 均成功，006 门禁仍 GATE_PASS，W3 fixture 不再因 E_T02C_FIXTURE 级联失败。

B-3：原 live-api 已调用 DELETE 用户 API 且日志为 200；残留是生命周期软删除墓碑。让脚本显式断言 DELETE 200，并向 harness 提供精确的自建用户 id/username。after-check 验证两个有效契约账号 + 仅该测试用户一条 disabled/deleted_at 非空墓碑、旧 token/新登录被拒且不可复活；不物理删除审计身份，不扩大为“任意额外用户允许”。保留原 49/49 场景与其它 11 项 after-check 断言。自有实例按 live-api 在 report-auth fixture 与学校 B 业务写入之前运行，要求 49/49、after-check 全绿、readyz=200。

三项逐条留下修复前/后 rc、源 hash、冻结 29、输入归因、HASHES_FINAL 双复验、实例 down；0 skip。未 stage/commit/push、未部署；明文停止并回交总控。
```

## 窗口 L：生命周期测试合同 + 004 补证（B-4/B-5）

```text
执行 P3-LIFECYCLE-CONTRACT-R7。先读 R17 复审、CLOSE-B-R3 的 S11/S12 日志、R6 的 004 并发修复证据。只编辑 backend/tests/session/w1-invalidation-matrix.integration.test.mjs、backend/tests/openapi/package-contract.test.mjs、backend/tests/openapi/stats-date.integration.test.mjs，以及本包新的 004 双会话证据脚本；不改 UserManager、grant 读时闸门、004 产品脚本、迁移/schema/client 或旧证据。用独立 PG 实例，不与其它窗共享。

B-4：正式 deleteUser 已是软删除。保留原会话矩阵全部 12 场景和 epoch/旧 token 401 判据，只把“物理行数 0”旧断言更正为同一行 status=disabled、deleted_at/deleted_by 置位；补登录拒绝及 enableUser 禁复活正反例。不得恢复物理删除或降低审计保全。

B-5：package-contract 管理端 dict 的 Prisma 替身补 School.id/generation 与 grant.school_id/school_generation；stats-date 真库 setup 从当前 School 行读取 id/generation 创建授权，若有旧缺身份测试 grant，显式删除/重授该测试记录，不在产品读时自动补值。保持缺身份、错实体、旧世代授权 403/隔离的负例及有效授权 200。定点复跑该两文件，覆盖旧日志的 12 项同因失败。

R6 补证：在 A 期专用 schema（principal_id 可空、CHECK NOT VALID）使用两个真实 PG 会话和明确时序门闸。脚本事务内重读未绑定行后暂停；竞争会话以合法已有 user principal 绑定该行并改变快照，满足 CHECK 后提交；脚本继续条件 UPDATE，必须拒绝或仅按“已由竞争者绑定”的明确幂等语义处理，不能覆盖为旧映射主体；竞争写入保留、新 mapping 主体不存在。另核对旧 token/主体合同不受本测试污染。报告真实 session/PID、每步 rc、竞争提交前后审计行与主体指纹。不得把 R6 同事务 hook 冒称双会话。

定点全绿后按源 hash/冻结 29/输入归因/HASHES_FINAL 双复验收口，实例 down、0 skip、明文停止。未 stage/commit/push、未部署。
```

## 窗口 P：公共链单测的历史位置证明（B-6）

```text
执行 P3-PUBLIC-INFRA-TESTS-R2。先读 R17 复审、CLOSE-B-R3 S12 原始日志中 6 个链断言失败和当前 16 文件链。编辑面只限 backend/tests/tenant-sync/{publicInfraChain.unit.test.mjs,publicInfraFollowup.unit.test.mjs,w2t02r4-unit.test.mjs,w2t02r5-unit.test.mjs,w2t02r6-unit.test.mjs} 与新证据；不改任何 migration/引擎/schema/client、历史 CHAIN_TAIL_LOCK 或旧证据。

六个失败均来自 14 文件时点的“总数/尾部位置”假设：现链 = 旧 13 字节不变 + 第 14 条 public FieldOption FK 前向修复 + M1 + M2 = 16。断言保留旧 13 文件逐项 SHA/顺序与三个 public-only migration 的 scope/形状、FieldOption FK 在第 14 位，并验证 M1/M2 只追加其后；不能把所有 14 机械换成 16，也不能把旧 public migration 冒充当前链尾。用当前产品 chainManifest/digest 与逐文件清单交叉核对。

离线跑上述五文件（重点六个原红断言）及 tenant-sync 相关单位入口，0 fail/0 skip；现行其他合同断言保持。输出修复前/后逐项 rc、输入 hash、冻结 29、HASHES_FINAL 双复验，明文停止；未 stage/commit/push、未部署。
```

## 最后才发：CLOSE-B 独占全量复跑与 runner B-7

```text
待 F/L/P 三窗全部明文停止并经总控复核后执行 P3-CLOSE-B-R4。R3 红链、RESULT 与 HASHES 原样保留，新建 evidence/P3-CLOSE-B-R4/。先静态固定 16 链/M2/B client/004/runner 文件集与三包源 hash，确认入口审计 24/24、单项定点全绿。

在新 R4 runner 内补 B-7：W3 实例 fixture 成功后再读取它生成的 env 文件，不能在 S0 模块加载时固定空 w3Env；给 W3REG PG 用例显式传 W3REG_ADMIN_DATABASE_URL（由同实例 W3_ADMIN_DATABASE_URL 派生）、BACKUP_DIR、BACKUP_MASTER_KEY，逐项核对 URL 的 runId/端口/DB/管理角色与目标实例一致。缺任何值依旧 fail-closed；旧 R3 runner/证据不改。T02B fixture 要在 16 链的 T02E fixture 成功后、root DB Jest 前运行，并把产物作为 T02B_FIXTURE_FILE；若发现产品数据污染，销毁实例重建，不用手工 SQL 清场。

独占全新 PG 实例按 migration-first + fixture 授权合同运行全部正式入口一次：root DB、unit、integration、isolation、live-api（先于 report-auth fixture/学校 B 业务写）、report-auth、session、backend 46 文件；包括 W3REG PG 真实用例。逐文件“清单数=执行数”、所有入口 rc=0、0 skip、readyz=200、真实租户 API、db:sync --check 与 006 GATE_PASS。负例入口的缺配置拒绝保持。若有任何红，按原始日志分栏并停止 PASS 主张，不改产品闸门/受保护断言凑绿。

收尾固定输入无漂移、冻结 29、git diff --check、逐入口原始 rc 与计数、HASHES_FINAL 双复验、实例 down/端口/会话/凭据清理。全绿才报 PASS_LOCAL_REGRESSION；真实部署、deploy.sh 两段接线和发布回退仍另验。未 stage/commit/push、未部署。
```
