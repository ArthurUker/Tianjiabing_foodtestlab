# P3-W0-T02B — Orchestrator review

日期：2026-09-25。裁决：**REWORK（仅 T02B 验收未完成）**。root Jest 接入同一隔离 setup 的实现方向成立，真实 p0 与 root 全套结果可保留；但任务包要求的几个安全判别仍缺证据，故不宣布 T02B PASS，不启动 backend 后续入口，AUD-039 保持 OPEN。AUD-044 与 T02A 既有本地 PASS 不变。

总控只读复核 `jest.config.cjs`、p0 测试、root 门禁回归、观测预载、controller fixture、结构化 Jest JSON、清理登记与 hash；没有代跑测试或 PostgreSQL，没有修改应用/测试。独立 hash：T02B 输入 315 项中 313 未变、2 项授权变化、0 越权/缺失；T02B 输出 39/39；冻结审计 29/29。HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，index 空。

## 已确认的范围

- `jest.config.cjs` 在 `setupFiles` 加入与 integration 相同的 `db-isolation-setup.cjs`；受控 p0 通过真实 Prisma transaction 调用共享身份核验及生产 purge。controller fixture 建立任务派生的学校与平台 admin，测试角色无 public School/User 写权限。
- 原始结构化结果：isolation **54/54**，p0 **6/6**；root **250/252**，仅 `authSession.test.js:259` 与 `:294` 两项历史失败，0 skip、0 新增失败，root 命令实际 rc=1。T02B 报告的两个实例均登记安全关闭，after-check 的 sentinel、平台 admin 与任务行结论一致。
- 以上是现有正例与运行结果，不能替代任务包规定的拒绝路径、观测器自证及故障路径证明。

## 未满足的退出条件

1. **root 拒绝入口与观测不可判别。** `t02b-root-gate.test.cjs` 的三例均调用同一个 `jest --config ... --runTestsByPath p0` 子进程；任务包分别要求 `npm test`、直接 config、直跑 p0 的无配置拒绝。`runRootJest` 在观测文件缺失或 JSON 损坏时仍给 `attempts=0`，预载/写日志失败会被误报成零连接；没有合法受控连接边界或观测器自测正对照。子进程原始 rc/输出/观测也未逐例落盘。任务包要求的旧 dotenv 路径 fail-on-access/等价观测未提供。
2. **School 写前范围判断有空集通道。** `verifiedWriteTx` 只执行 `codes.some(c !== fixture.schoolCode)`；当清单为空时返回 false，业务 callback 仍可继续。`beforeAll` 只核对 fixture 的 runId/schema，未把 `fixture.schoolCode` 与 `cfg.tenants.a` 绑定。当前真实 fixture 正例有一行，不会暴露这些拒绝条件；应在同一事务内要求**恰好一个**任务派生 code，并证明空集/越界时 callback=0、DML=0。
3. **写后失败与收尾失败证据缺失。** 现有 p0 第⑥例仅在任何业务写入前注入身份不符；没有任务包要求的“先写一行再抛错 → 真实 transaction 回滚/登记清理有效”用例。`afterAll` 调用 `settleAll`，但没有清理或释放失败整体非零、保留原错误的判别用例与原始 rc/日志。不能用最终任务行 0 推断这些失败路径。

另有 `t02b-after-check.json` 的 `sentinelErr=IDENTIFIER_INVALID` 是一次已纠正的取证过程错误；最终 sentinel before/after 相等，但后续报告应保留并解释这条字段。执行者再次自报写入包外“工作记忆”；总控不读取或清理私有记忆，仓库清单也不能证明其状态。

唯一下一任务：[P3-W0-T02B-R1_REWORK_PATCH_PROMPT.md](../../reviews/global-audit-20260924/phase3/P3-W0-T02B-R1_REWORK_PATCH_PROMPT.md)。输入：[P3-W0-T02B-R1_REVIEW_INPUT_MANIFEST.json](../../reviews/global-audit-20260924/phase3/P3-W0-T02B-R1_REVIEW_INPUT_MANIFEST.json)。R1 只补上述三组判别，不重做已接受的 T02B 正例，不触碰生产、T02A/W0-T01 或 backend 旧入口。R1 完成后交总控复审；T02B 与 AUD-039 均暂不关闭。
