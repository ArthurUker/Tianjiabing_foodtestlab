# P3-W0-T02B-R1 — Orchestrator review

日期：2026-09-25。裁决：**REWORK（R1 的 B 与真实回滚可接受，T02B 尚未验收）**。AUD-039 保持 OPEN；T02A/W0-T01 既有本地 PASS 不变。总控只读复核 R1 限定代码、结构化结果、原始观测、实例登记及 hash，没有代跑 Jest/PostgreSQL，也没有修改应用或测试。

独立核验：R1 输入快照 **352 项：348 未变、3 授权修改、1 仅追加且旧前缀 hash 一致、0 越权/缺失**；R1 输出 **67/67**；冻结审计 **29/29**。HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，index 空。结构化结果 isolation **63/63**、p0 **11/11**、root **255/257**（仅 `authSession.test.js:259` 和 `:294` 两项历史失败，0 skip，root rc=1）。这些结果与 R1 报告的计数一致。

## 已闭合的部分

- `beforeAll` 现把 fixture 的 runId、schoolCode、schoolSchema 绑定到受验证配置；`verifiedWriteTx` 在共享身份核验后调用同一 `assertSchoolScope`，要求 School 清单恰好一行且为任务派生 code。空集与越界合成负例调用同一范围函数，真实正例在受限实例通过。
- p0 第⑨例在真实 Prisma 事务里写入后抛错，随后在新事务查得该行 0 条；第二实例的 after-check 也记录回滚行 0、sentinel 与平台 admin 不变。原五项语义、身份拒绝和 root 两项历史失败对照保持。
- 三种 root 入口以及缺 context/冲突等负例已有真实子进程 rc 和安全日志；观测器有临时回环连接的正对照。既有结果不必推倒重做。

## 仍未满足的退出条件

1. **门禁“零连接”会被旧观测冒充。** `root-entry-runner.cjs` 用固定 `gate-<label>.net.log`，运行前不创建独占新文件，也不校验日志是否属于本次子进程。现存 `gate-direct-p0-missing-config.net.log` 含 PID **74044 与 76780** 两轮记录；`gate-npm-test-missing-config.net.log` 也有两批 PID。`readObservations` 只要求至少一条 boot，**仅 boot、无任何退出连接记录仍返回 `valid=true, attempts=0`**。因此本轮若预载已启动但写回失败，或新运行没有产生任何日志，旧 boot 仍可让负例通过。这正是 R1 要关闭的不可判别通道。需要每次运行唯一归属、每个 boot 的终结/连接记录、缺项 fail-closed 与可失败自测。
2. **观测辅助钩子尚无自身正对照。** module probe 把模块日志不存在或空都判“未加载”，没有证明模块加载钩子在本次运行能记录一次受控命中；dotenv fail-on-access 只有“没有触发”的负例，没有合成路径读取触发 `T02B_DOTENV_ACCESS` 的正对照。两者可在新证据中以合成 canary 补齐，不读取真实 `.env`。
3. **收尾失败与实例复核的口径未闭合。** p0 第⑩例只调用独立 `settleAll` 并断言 `r.ok=false`，实际 p0 `afterAll` 路径没有受控失败；测试进程整体仍 rc=0，尚不能支持“清理/释放失败整体非零且保留原始业务错误”的表述。R1 补丁包还明确要求 p0 定点后在**同一安全实例**重跑 root 全套；R1 登记显示 root 在 55534、p0 与成功 after-check 在 55535，55534 的 after-check 因 SQL 拼接错误没有可用结果。需在同一新建自有实例上完成 p0 → root → after-check → 安全 down，并验证实际收尾错误路径。原过程失败与两实例记录应原样保留。

唯一下一任务：[P3-W0-T02B-R2_REWORK_PATCH_PROMPT.md](P3-W0-T02B-R2_REWORK_PATCH_PROMPT.md)，输入 [P3-W0-T02B-R2_REVIEW_INPUT_MANIFEST.json](P3-W0-T02B-R2_REVIEW_INPUT_MANIFEST.json)。只处理上述收尾，不启动 backend 旧入口或 W2a，不宣布 T02B/AUD-039 完成。
