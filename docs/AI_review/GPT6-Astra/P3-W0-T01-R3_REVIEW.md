# P3-W0-T01-R3 — Orchestrator review

裁决：**REWORK，仅故障 harness 与证据；A/B 应用实现静态审查接受。** 日期：2026-09-24。

总控读取实际共享库、生产调用、两个 harness、报告、日志并独立只读计算 hash；没有运行测试、应用、DB 或部署，没有修改应用。未重新全仓审计。本轮没有确认新的应用缺陷；以下问题是 R3 原验收要求尚缺有效证明，不能将测试打印 PASS 等同于验收通过。

## 接受并保留

- `deploy/lib/jwt-config.sh:178` 的完整组装是生产和测试共同调用的唯一实现；各行写入/fragment 读取显式检查返回码。生产 §5.2 对 assemble/publish 非零调用 fail。
- `jwt_config_publish_env:97` 在同目录 staging 上完成 chmod/chown、mode/uid 校验后才 mv，mv 后无权限操作。prepare 的 chmod 失败返回非零。保持“不要求发布后完整回滚”的原边界。
- owner group 依赖真实 chown 成功，独立 stat 只核验 uid；不把 uid 相等描述成独立证明 gid。当前 600 权限、真实 chown 失败处理及既定本机测试边界下，本轮不要求另建跨平台组解析器。SEC 的 chown 替身不能证明生产服务用户配置正确，原未执行边界继续保留。
- lifecycle 的 B1 已使用独立旧副本/保存值，真实 dotenv 比较 access/refresh、16 个非 JWT 字段、mode 和二次 access 稳定；D1/E1 及以前的解析/签名/启动隔离结论保留。
- 已存日志汇总为 lifecycle 31/31、fault-injection 50/50、deploy-flow 42/42；这是执行记录，fault-injection 部分断言的证明力受下述缺陷限制。
- 独立重算 R3 HASHES_FINAL：14/14；冻结清单：29/29。相对 R2 输入 117 条，112 未变、5 个路径为本轮授权修改、无缺失；新增故障 harness 不在旧清单中。PF 固定输出仍为 `3cc569586ae6b75835ec90fd795e6bbf875f6bb480c44c0462dbbe24a098a148`，未再覆盖。
- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，branch `Product_tencent_CVM`，index 空；5 tracked 文件累计 +138/-53。未提交应用改动保留。

## 必须补齐的证据

### E2：旧目标 hash 基准采集晚于被测操作

`backend/tests/security/deploy-env-fault-injection.test.sh:79` 在 assemble/publish 之后计算 target_hash，`:92–95` 再比较这个操作后 hash 与退出后的目标；即使被测操作已错误改写目标，两个 hash 仍可相等。

INJ-4 的 H4 在操作前保存（:142），但后续没有使用，仍走上述操作后比较。SEC-1 的 EXPECT_H 在 run_section 之后才计算（:263），下一条 hash 断言也属于自身比较。它们无法证明“失败时旧目标不变”。必须在任何被测操作前保存独立基准，操作结束后与它比较，并用受控改写负例证明断言确实能失败。

### E3：部分调用计数和清理结论没有对应观测

- 仅 mv_fail 分支定义记录 mv 的替身（:61）；其余分支读取空 calls.log（:73–74），所以 INJ-1/2/3/6/7 的 mv=0 不足以证明未调用。应在全部有关路径安装统一计数包装，正常时转交真实 mv，专用失败场景才注入非零。
- INJ-5/6/7 没有执行退出后清理断言，而报告统一写“已清理”。`inj_paths_clean` 在路径为空时也会返回 true（:98–103）。需要检查观测记录完整、路径属于本 case 且已登记，然后检查退出后确实不存在；不能以缺失字段当清理成功。
- SEC-2 未断言未走到片段结尾、旧目标不变与清理；SEC-3 只断言目标含 JWT_SECRET，而旧目标本来就含该键。真实 caller 的 fail 路径已有部分证明，仍需补足原退出条件。
- INJ3_partial_proof 另写 printf 块，仅说明一般 shell 行为；应直接在失败的真实 assemble staging 清理前记录必要字段存在/缺失布尔，不输出合成密钥。

这些均属于同一个问题：观测器必须能区分正确与错误结果。修订集中在一个故障 harness，不要求生产实现再次重构。顺带将测试替身里的 `builtin chmod` 改成可调用真实外部命令的方式，避免未命中注入条件时产生无关失败。

## 下一步与停止边界

唯一任务为 [P3-W0-T01-R4_REWORK_PATCH_PROMPT](../../reviews/global-audit-20260924/phase3/P3-W0-T01-R4_REWORK_PATCH_PROMPT.md)：仅补齐上列断言、观测及新证据。生产代码保持当前字节；原 R3 日志/JSON/hash 不改写，只在新报告说明修正。旧 fault 日志 SEC_extract 行存在编码损坏，新日志用简单 ASCII case ID 与结构化字段即可，不要求重做历史日志。

AUD-044 整体暂不关闭，AUD-039 不启动。下一轮只核验 R4 证据及受保护文件未变，不重新开启已接受的 D1/E1、解析和架构讨论。
