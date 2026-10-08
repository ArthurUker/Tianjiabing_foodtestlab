# P3-W0-T02A-R2 — Orchestrator review

日期：2026-09-25。裁决：**REWORK**。AUD-039 仍 OPEN；AUD-044 保持 REMEDIATED_LOCAL / PASS。

本次仅对照 R2 任务包复审源码与落盘证据、只读计算 hash；总控没有执行测试、启动 PostgreSQL 或修改应用。以下均是既有验收要求的剩余项，不新增全仓审计或架构决策。不声称本轮实际误删了实例；指出的是仍可到达的错误分支。

## 已接受并保留

- 非目标库 postgres/template1 的 CONNECT 显式收回。live-probe 对 postgres 使用同一正确测试凭据，只改数据库名，日志为 42501；管理员冒用另测为 28P01。不要将这一跨库动态结果扩称已逐库实测 template1。
- psql 参数不再带密码 URL，实际调用前核对参数，PGPASSFILE 为 0600。marker 检查 INSERT/UPDATE/DELETE/TRUNCATE，UPDATE 授权注入拒绝、撤销后恢复的真实证据有效。
- helper 的 URL/code/expectedSchema 前置拒绝已在 factory/transaction 前；正例同事务验证、原业务语义、提交后登记/allSettled 保留。真实六项并发五项成功、一项失败，清理至零的测试有效。
- setup 的 Node net 连接观测有零尝试负例和正对照；证据限被测 setup/Node 网络边界，不能概括为观察了 Prisma 原生引擎全部连接。
- 正常 down 现要求 stop=0、进程 absent、端口 released；正常真实关闭及部分异常测试有效。汇总器已拒绝空/缺失/畸形 rc，并有缺必需 case/check 的副本自测。
- 独立核验：R1 输入快照 221 项，211 未变、10 授权变化、0 缺失/越权；R2 HASHES_FINAL 44/44；冻结 29/29。新增 observer 两文件和 rework2 证据在包内。HEAD/branch 不变，index 空；累计 tracked 9 文件 +525/-257。
- 现存日志：isolation 29/29、integration 22/22、probe 25 个必需 check、汇总自测 6/6（其中一个正对照、五个负例）。**isolation 实际分布为 gate 14 + lifecycle 12 + entry 3**，不是报告中的 18+8+3；“八个必需 lifecycle case”不是 lifecycle 总测试数。

## L：生命周期仍把不确定性变成清理授权

1. `tests/isolation/provision.cjs:28` 的 probePid 接受 rc=1 且 stderr 有错误的空 stdout 为 absent，rc=0 空 stdout 也视为 absent，非空输出没有验证其 PID。`:35` 的 probePort 用 Number/filter 丢掉畸形行：rc=0、stdout=`garbage` 会得到 released；rc=1、stderr 有错误也可得到 released。它们不是报告声称的“畸形输出→unknown”。down 在 stop 成功后的复验会消费这些错误结论。
2. `:43` 的 pidfile 解析允许缺失 startTime 被 Number('') 变成 0，畸形 port 变成 null；`:109` 的核验又允许 port=null。ownership 写入根本没有 postmaster startTime，核验没有比较启动标识。命令路径匹配还存在 `includes(rec.datadirReal || '')` 的空串放行。当前单测名写 PID/datadir/port，实际只篡改了 pidfile PID，没有覆盖上述边界。
3. `:290` 起 up catch 没有调用共同归属核验。任何监听者或 pidfile 指向的存活 PID 都会被标成 detectedOwnInstance 并尝试 stop。反过来，start_attempted 后 pidfile 缺失且端口空闲，会走 safeToRemove=true；“尚无可读取 PID/监听”不能证明启动尝试已终止。启动前端口冲突检查也只看 lsof rc=0，把工具错误当空闲。
4. lifecycle 的 start 非零测试先删除了合成 pidfile，随后仅注入端口监听，仍期待 detectedOwnInstance=true；它在固化不充分的归属判断。真实目录 afterAll 已不直接 rm，但留下 RESIDUE_REPORT 后仍不让 suite 失败。status 还读取核验器已不返回的 alive/cmdOk/portListening，JSON 中这些字段被省略。

必须严格三态解析，并让 up 失败、down、status 消费同一个归属判定。启动已尝试但证据缺失时，保留现场、零 stop/delete 是可接受结果；不要求实现自动抢救未知实例。

## H：原包要求的不可变契约与真实 helper 拒绝仍未完成

- `tests/helpers/db-isolation.cjs:246–272` 返回普通 cfg；嵌套 allowedSchemas/allowedFixtureObjects/tenants/schemas 等同样可改。新增前置函数和注释称 cfg frozen，不等于已冻结。R2 明确要求冻结验证后的 cfg 和嵌套契约。
- `tests/integration/concurrency.test.js:204` 的 `{1,1,0}` 来自 beforeBusiness 主动抛 STOP_BEFORE_BUSINESS；这一 hook 在共享核验**成功后**执行。它不能证明共享核验拒绝时业务回调为零。`:179` 的真实 schema 不符用例仍单独调用 createTenantClient+verifyRuntimeIdentity，不经过消费 helper。需要同一个 withVerifiedTenantTx 上的真实核验失败和 factory/transaction/实际业务 callback 计数，保留现有正例。
- `db-isolation.cjs:427` 只在 connected=true 时 end；connect 拒绝后不尝试释放已创建 client。`live-probe.cjs:36–37` 的两个 adminClient 在 try 外创建，第二个 connect 失败会漏掉第一个；adminClient 自身 connect 失败也未 end。provision 的 withAdmin 和 fixture client 同样先 connect 后 try。R2 §3 已要求覆盖这些路径及原错误/释放错误同时保留，这部分尚未落实。跨库/冒用负例中的 end 错误也被空 catch 丢弃，需与预期认证/授权拒绝分别记录。

## E：严格读取已改善，但部分汇总字段仍接错证据

`rework2/make-test-results.mjs` 中：

- mismatch_zero_connection_attempt 仍只由无 ECONNREFUSED 得出，没有消费新增 observer 用例的通过记录。
- partial_commit_then_cleanup 读取的是 live-probe 的“两个删除动作之一失败，剩余一行”，并非 integration 中的“并发五项提交后清零”。这是 R2 明令分开的两类场景。
- residue.task_instance_dirs_remaining=0 为写死值，不能作为实际清理观测。当前正常 down 成功日志保留，但不能据此概括整个 suite 所有临时资源。

新汇总应引用对应来源，缺失/失败的真实用例不得由另一类证据替代；旧 rework2 文件全部保留。修正计数和 hook 语义的报告措辞，不回写旧报告。

## 唯一下一步

执行 [P3-W0-T02A-R3_REWORK_PATCH_PROMPT.md](P3-W0-T02A-R3_REWORK_PATCH_PROMPT.md)，输入为 [P3-W0-T02A-R2_REVIEW_INPUT_MANIFEST.json](P3-W0-T02A-R2_REVIEW_INPUT_MANIFEST.json)。只闭合 L/H/E；不重做已接受的权限架构、不接入 root/backend、不启动下一 wave。

执行者再次提到“工作记忆”。原包明确禁止包外写入；总控没有检查私有记忆，仓库 hash 不是全机完整性证明，也不授权回删未知文件。
