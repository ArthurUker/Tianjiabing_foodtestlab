# P3-W0-T02A-R4 — Orchestrator review

日期：2026-09-25。裁决：**PASS，P3-W0-T02A 本地验收完成**。这只覆盖共享隔离门禁、专属 provisioner 与两个 PG integration 套件；AUD-039 仍 OPEN。AUD-044 保持 REMEDIATED_LOCAL / PASS。没有提交、部署或现网验证。

总控对照 R4 任务包只读复核实际 `provision.cjs`、`lifecycle.test.cjs`、结构化 Jest 结果、逐例观测、实例登记和 hash；未代跑测试或 PostgreSQL，未修改应用。

## R4 退出条件

- **L1**：默认 spawn 包装传递 `error`/`signal`；`probePid` 和 `probePort` 在 rc=0、stdout 表面有效而 stderr 非空时返回 unknown。`up` 的端口预检也复用该结果；未知状态无法授权 initdb/start、stop 或删除。R4 的定点用例覆盖预检、down 预检、stop 后复验及 spawn error/signal；正常 no-match 和存在正对照保留。
- **L2**：`readOwnership` 现分别核对原始 datadir 与 datadirReal 的存在、绝对路径和指向任务 data。`down` 删除已停止实例的捷径已取消；缺完整自有证据时即使旧 PID/端口空闲也返回非零、零 stop/delete 和 manual 信息。现有唯一路径是完整互核 → stop rc=0 → 原 PID absent → 原端口 released → 删除。
- **L3**：`up` 在 start_attempted 后的失败收尾调用同一个 `down`/`assessOwnership`，不再另算较弱的归属条件。ownership 缺失或与 pidfile 冲突且 ps/lsof 表面一致的用例均零 stop/delete；真实 trigger 失败正例保留原始错误，并在自有实例上完成安全 stop/复验/删除。

逐例观测文件记录 36 条（down 31、up 5）：30 个需要保留现场的 down 用例均保存目录/文件基准；1 个完整证据正例 stop 一次后删除。up 三个合成危险例均零 stop/delete；真实正常链路和 trigger 失败收尾成功。日志报告 isolation **51/51**（gate 21 + lifecycle 27 + entry 3）、真实 live-probe 定点复验 rc=0、provision up/down rc=0、自测 8/8、主汇总 8/8。过程中的变量名笔误、自递归和汇总基准错误及重跑已在 R4 报告中保留，不能按“首次即全绿”叙述。

独立只读 hash：R3 输入快照 290 项中 **288 未变、2 授权变化、0 缺失/越权**；R4 HASHES_FINAL **25/25**；冻结审计 29 文件 **29/29**。HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM` 不变，index 空；`git diff --check` clean。根 Jest、backend node:test 和全部旧套件本轮未运行，R3 integration 23/23 为已接受的引用结果。

## AUD-039 后续边界

已知 root Jest 的 `tests/p0ProvNoAdminInSchool.test.js` 仍有 `new PrismaClient()`、动态建表、`DROP SCHEMA … CASCADE`、针对所有活跃学校的 purge；root Jest `tests/setup-env.js` 只有 polyfill，未挂共享隔离门禁。backend `_isolation.mjs` 仍按旧 `REVIEW_TEST_DATABASE_URL` 约定，`tests/integration/live-api.mjs` 依赖外部服务。T02A 的 PASS 不表示这些入口已安全。下一包先接入 root Jest 的已知危险套件，backend 与 live-api 留待后续，避免同时改两套测试架构。

唯一下一任务：[P3-W0-T02B_TASK_PACKET.md](../../reviews/global-audit-20260924/phase3/P3-W0-T02B_TASK_PACKET.md)，输入为 [P3-W0-T02B_INPUT_MANIFEST.json](../../reviews/global-audit-20260924/phase3/P3-W0-T02B_INPUT_MANIFEST.json)。Phase 2 49 项严重度与架构裁决不变；餐具三项 delta 仍另列，不因此启动 W2a。

执行者再次提到包外“工作记忆”，违反已发任务包的范围限制。总控没有检查或清理私有记忆；仓库 hash 仅证明列入清单的文件状态。后续任务继续明示禁止包外写入。
