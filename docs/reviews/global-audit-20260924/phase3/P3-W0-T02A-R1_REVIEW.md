# P3-W0-T02A-R1 — Orchestrator review

裁决：**REWORK，限以下剩余缺口；不重做已接受的 R1 正例实现。** 日期：2026-09-25。

总控只读复核实际源码、测试、任务包和证据并计算 hash，未执行测试/PG/部署，未修改应用、未查看真实凭据。AUD-044 维持 REMEDIATED_LOCAL / PASS；AUD-039 OPEN，T02A 未验收。

## 保留的有效进展

- Prisma 正例已调用共享核验：interactive transaction 的同一 tx 先核验身份/schema，再执行真实业务 SQL，继续使用生产 createTenantClient。
- namespace 由 runId 派生；角色五项严格 false、拒绝直接成员关系；受限角色、真实 trigger 与 sentinel 正例保持。不要重开这些架构选择。
- concurrency 已在事务提交后立即登记，并等待 allSettled；清理 API 改为结构化行键；settleAll 分别尝试动作；keep 对象已提前创建。
- 显式 stop 非零分支已保留目录；up 的 trigger 失败已有一次真实停止/清理记录。
- 日志自报 isolation 20/20、integration 16/16（原 13 + 3 新增）、probe 21 项。它们只证明实际断言，不能代替下述未满足边界。
- 独立 hash：输入 190 项中 181 未变、9 授权变化、0 缺失；新 lifecycle 不在旧输入中。R1 产物 41/41、冻结 29/29 一致。原受保护文件保持；HEAD/branch 未变、index 空；累计 tracked 9 文件 +424/-258。

## B 剩余：跨库权限未被证明，管理员密码进入 argv

`tests/isolation/live-probe.cjs:76` 用 `probe-wrong` 作为测试角色密码连接 postgres，catch 任意错误就记 cross_database_connect_denied=true。这只证明该错误密码不能连接，不能证明正确测试凭据受 CONNECT 限制。`provision.cjs:194` 只 REVOKE 目标库的 PUBLIC CONNECT，没有对其他可连接库建立同等约束；probe 未隔离认证失败与授权失败。必须使用同一正确测试凭据、只改变数据库名，先证明目标库成功，再验证其他库的权限拒绝。

`provision.cjs:207` 把含 aP 的管理员 URL 作为 psql 参数。这直接违反 R1“管理凭据不进 argv”的要求，也与返回摘要相反；这不是日志是否脱敏能解决的问题。需要改为受限凭据文件等非 argv 来源，并对实际 spawn 参数做不泄密断言。

marker 的 catalog 核验只查 INSERT（`db-isolation.cjs` markerRes），UPDATE/DELETE/TRUNCATE 权限不会触发此拒绝；真实 probe 当前 UPDATE 被拒说明当前 fixture 无此授权，不等于门禁能够发现将来错误赋予 UPDATE 的情形。需覆盖 marker 的写权限集合，保留当前只读正例。

## C 剩余：清理仍在不确定状态下删除

- `verifyLiveOwnership` 仍以 ps 字符串 includes(datadir) 判归属，consistent 只等于 alive && cmdOk，端口结果不参与；没有把真实 postmaster PID/datadir/start identity/监听端口关联起来。记录字段存在不等于已经验证。
- down 计算 portReleased 后只检查 processGone，端口未释放仍 rmSync 并 ok=true（:266–271）；ps/lsof 探测命令失败也可能被当作进程消失或端口释放。
- up 在 pg_ctl start 非零时还未登记 started_instance，catch 直接进入删除目录分支。start 超时/报错不能证明子进程没有启动，仍存在删除运行中数据目录的可能。up 异常路径 stop 成功后也未像 down 一样重新核验进程/端口再删除。
- `lifecycle.test.cjs` 的 afterAll 无条件 rmSync 所有 tracked root；其中包含真实 initdb/start 用例。即使生产工具正确保留了停止失败的现场，测试最终清理仍可能绕过该保护删除它。此项必须与工具同时修正。

本次正常 down 的成功记录保留；上述是源码可达异常分支，不声称本次实际删了运行中的实例。

## A/D 剩余：前置检查与负例仍可失去判别力

- `withVerifiedTenantTx` 在执行 schema/环境一致性检查前调用 createTenantClient，cfg 没有冻结；beforeAll 的一次 URL 相等断言不满足每次实际创建客户端前的检查。应在测试 helper 中完成前置拒绝，不改生产模块。
- 新 pg 拒绝测试未抛错时进入 expect(true).toBe(true)，门禁失效也可以通过。Prisma 负例单独手写 tx+核验，没有通过 withVerifiedTenantTx，且 calls 只记录核验 adapter，后续直接 INSERT 本身不会计入该列表。应测试实际消费 helper，并对业务 callback/执行器计数。
- 入口仍以无 ECONNREFUSED 当“零连接”，没有补上 R1 要求的实际工厂/连接观测和正对照。
- 本轮没有注入真实并发写入“部分提交后失败”来证明登记时机与 allSettled 清理；probe 的“部分成功”指清理时两项中一项失败，是另一种场景，不能混用。
- R1 汇总器 readRc 对空字符串使用 Number('')，得到 0；“空数据拒绝”没有实现。下一轮需对空/缺失/畸形 rc 和缺必需 case 做受控自测。

## 下一步

只执行 [P3-W0-T02A-R2_REWORK_PATCH_PROMPT](P3-W0-T02A-R2_REWORK_PATCH_PROMPT.md)。不新增审计 issue，不接入 root/backend，不执行 W2a。旧 R1 证据原样保留，由新报告明确修正跨库、argv 和拒绝观测的口径。

执行者仍提及包外“工作记忆”写入；总控未检查私有记忆、不将仓库清单扩称全机完整性。下一任务再次明确禁止，亦不授权回删未知文件。
