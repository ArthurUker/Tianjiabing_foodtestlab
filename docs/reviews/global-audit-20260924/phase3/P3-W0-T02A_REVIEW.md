# P3-W0-T02A — Orchestrator review

裁决：**REWORK。T02A 尚未验收；AUD-039 OPEN；AUD-044 的 REMEDIATED_LOCAL / PASS 保持。** 日期：2026-09-25。

总控读取用户执行报告、实际源码、任务包、单元/真实探针、证据生成器与结果，并独立只读计算 hash；未执行测试、应用、PG、部署或资源删除。以下为既定 T02A 契约的差距，不新增 finding、不重做全仓审计。

## 已确认的进展

- 已去除 integration 的普通 DATABASE_URL/default URL fallback、roleAudit 缺变量 skip 及固定账号选择；Jest setup 挂载真实纯配置门禁。
- 实际 DB 租户改用任务派生 code；roleAudit 使用受控 pg Client 与真实 trigger SQL。真实正例记录为两个 suite 13/13，新增单元 17/17；真实 sentinel 读写拒绝与 before/after 摘要存在。
- 独立 hash：输入 152 项中 148 protected 未变、4 授权 integration 文件变化、0 缺失；本包 HASHES_FINAL 40/40；冻结 29/29。W0-T01 未被修改。
- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`、index 空。累计 tracked 9 文件 +313/-222。没有确认本次真实实例实际发生越界修改；问题在门禁覆盖与异常路径无法满足承诺。

## R1：Prisma 业务连接不受运行时门禁保护

`concurrency.test.js:48–60` 只验证额外创建的 pg Client，随后独立创建 basePrisma。`:78–81` 与并发 INSERT 直接调用生产 createTenantClient 返回的 Prisma 客户端，从未在这些连接上验证身份/marker/schema。环境 URL 相等不能替代实际连接核验。报告所说“校验与操作绑定同一受控连接”仅对 roleAudit 与清理 pg Client 成立。

修复必须留在测试层，继续测试真实生产 tenantClient；可用 Prisma interactive transaction，在同一 transaction client 上先执行共享只读核验再进行实际查询/写入。不能改成全用 pg 查询从而丢失原 Prisma 隔离回归。

## R2：namespace 和角色边界不完整

- `db-isolation.cjs:135–137` 仅检查 allowedSchemas 标识符格式，不验证它们与 runId 派生集合一致；把 school_tjb 加入上下文即可使该 schema 的配置检查不再拒绝。roleAudit.schema/userId 原样传出（:193），消费方仅 quoteIdent，未与允许集合/任务 user 绑定。
- `verifyRuntimeIdentity` 未核对 current_schema、schema owner/允许对象实际状态；allowedFixtureObjects 只传递而未用于约束。可读 marker 值并不能证明该 marker 不可写。
- 成员查询只看一跳、且只拒绝父角色 rolsuper（:231 与后续循环）；非 superuser 的 CREATEDB/CREATEROLE/BYPASSRLS 角色和间接成员路径未覆盖。角色记录缺失/属性非布尔也没有 fail-closed。地址为 null 被接受，与 TCP 精确 loopback 契约不一致。
- provisioner 未建立“测试角色不能连接其他库”的授权限制与验证；`initdb --auth=trust` 还允许仅凭角色名选择管理身份，随机测试密码并未形成连接身份屏障。live-probe 也按 runId 拼管理员 URL 直接连接。独占实例仍是有效第一层隔离，但不能因此声称受限执行身份的第二层约束已完整建立。

修订需精确绑定 task namespace、实际操作 client、角色权限和 marker 的只读属性；新建实例采用真实身份认证并限制跨库 CONNECT。本包测试角色无成员关系需求，最小实现可以拒绝所有角色成员关系，避免不完整的提权图算法。

## R3：失败清理和生命周期存在真实漏口

- concurrency 在全部并发 INSERT 和后续断言完成后才 registry.add（:164–183）；部分插入成功、另一个失败或断言失败时，成功行尚未登记。Promise.all 首个拒绝后还可能有写入在飞行，不能立即清理了事。
- `cleanupRegistered` 接受任意有效 qname 与 whereSql，未绑定允许对象或本任务行键；登记本身不是对象归属证明。afterAll 的 firstError 逻辑会在已有错误时丢弃后续 cleanup/end 错误；connectGuarded 的 connect 在 try 外且 end 错误被吞掉。
- `provision.cjs:204–210` 不论 pg_ctl stop 的返回码如何都 rmSync 数据目录，并返回 removed=true。失败停止却删运行中实例的数据目录必须修复；本次日志 stop=0 不覆盖这个分支。
- down/status 没有与 up 一样校验 runId；status 用 port=0，归属检查主要是 ps 子串，没有核对实际端口。up 在启动后的 fixture/trigger 失败没有失败清理；probe fatal 分支也没有 finally 释放。需要明确已创建资源阶段与无法安全清理时保留现场的行为。

## R4：关键负例的证据不能替代实际观测

- 单元测试自称 connect=0，但首例调用了与门禁无关的 connect spy 并断言 1（gate.unit.test.cjs:68–74）。其余纯配置断言也不是实际入口的 connect 观测。
- `make-test-results.mjs` 的 config_negatives_observed 为手填 0/1；无 ECONNREFUSED 只能说明没观察到该错误，不等于证明没有连接。需要可命中的连接工厂/网络边界 spy，正对照证明其有效。
- live-probe 的 keepSchema 在清理完成后才创建（:99–104），不能证明清理保留了既有未登记对象。独立 sentinel 的前后比较有效，保留该证据，另将 keep 对象提前建立。
- 汇总只以 provisionDown.removed 推断“端口释放”，没有使用真实端口/PID 观测。新证据必须分开记录 stop rc、进程/端口/目录状态；缺失或解析错误不能默认为成功。
- 用户摘要提到额外记忆写入/跳过临时文件删除。没有检查用户私有记忆，也没有代删未知文件；新报告须列明本任务残留资源及归属，不能概括为全机无残留。后续禁止包外记忆写入。

## 下一步

仅执行 [P3-W0-T02A-R1_REWORK_PATCH_PROMPT](P3-W0-T02A-R1_REWORK_PATCH_PROMPT.md)。保留原包正例、原证据和 W0-T01 结论；修正上述门禁、生命周期与判别测试。不得接入 root/backend、不得启动 W2a，不需要用户重新决定 RC-10 架构。
