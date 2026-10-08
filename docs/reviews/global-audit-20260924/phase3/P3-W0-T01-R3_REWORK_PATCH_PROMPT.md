# P3-W0-T01-R3 — 仅闭合 D2 的实际写失败路径

你是 CodeBuddy。先读 `docs/reviews/global-audit-20260924/phase3/ORCHESTRATOR_STATE.md`、`P3-W0-T01-R2_REVIEW.md` 与本文件。短文件名均在 phase3 下。

## 状态与范围

Preflight PASS；D1 分发、E1 hash 收尾已接受；前两轮的 JWT 解析/强度/round-trip/CLI 无回显/配置源隔离保持接受。本轮仅闭合 D2，不重做以上事项，不启动 AUD-039。

HEAD=`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，branch=`Product_tencent_CVM`。沿用未提交 diff，不 reset/clean/stash。开始对照 `P3-W0-T01-R2_REVIEW_INPUT_MANIFEST.json`；其他新增用户改动保留并报告。

只允许调整 `deploy/deploy.sh` 的 §5.2 调用与必要函数检查、`deploy/lib/jwt-config.sh`、对应正式 harness 与本任务证据/说明更正。不改校验规则/解析器/UserManager/依赖/schema，不跑真实 deploy/systemd/DB，不 stage/commit/push，不写工作记忆文件。

## 必须实施的两个补丁

### A. 将生产的完整组装代码变为唯一实现

1. 把 deploy.sh §5.2 的**完整 prefix + JWT fragment + 完整 suffix**组装搬到真实共享函数（例如 `jwt_config_assemble_env`）；变量和值的含义、所有非 JWT 字段保持原样。secret 不通过 argv 传入。
2. 每次写入/读取都显式检查返回码。prefix、fragment、suffix 任一步非零，函数立即非零返回，调用方停止；不能依赖 set -e，也不能以四个字段的 grep 代替写入成功检查。保留有用的完整性检查作为附加验证。
3. deploy.sh 与 harness 均调用这一函数。删除测试内另写的 assemble_and_publish 内容生成逻辑或将其变为纯调用包装；不再由测试自己用带 `|| return` 的 printf 替代生产不检查返回码的 cat。
4. 受限 staging/fragment 仍由既有登记/trap 清理。正常完整组装后才能进入 publish；失败必须保持旧目标字节/hash 不变。

### B. 发布前完成权限与属主检查

1. 在 staging 上完成 mode=600、指定 owner（生产为 `$SYSTEM_NAME:$SYSTEM_NAME`）的设置/核验，失败则非零返回且不执行 mv。最后成功 mv 后不再做会使必要校验失败却返回 0 的 chmod/chown。
2. 保持 staging 与目标在同目录，确保走同文件系统 rename；路径条件不满足则拒绝，不静默退化为跨文件系统 copy。目标是目录/缺失目录等原有拒绝保留。
3. `jwt_config_prepare` 剩余的 chmod 失败不得 `|| true` 放行；非零返回并走调用方已登记资源清理。不要扩大为通用权限管理模块。
4. publish 后的其他部署步骤失败不要求回滚；SIGKILL/断电边界不扩展。本轮只保证发布前失败不覆盖旧文件，mv 本身失败时不继续。

## 必须执行的最小故障验证

全部在任务临时目录、仅合成值。使用测试子进程的命令替身/可控文件条件驱动**实际共享函数**，不得给生产添加跳过校验的测试开关。

- prefix 写入失败；fragment 读取失败；**suffix 部分写入失败**（先写出 JWT_EXPIRE/CORS_ORIGIN 两行，再返回非零）。后者专门证明“四字段存在也必须停止”。每个用例断言：真实非零 rc、publish/mv 未调用、后续/restart 未调用、旧目标 hash 不变、已登记临时文件无残留。
- 注入真正的 mv 返回失败，不能仅用目录不存在来替代；断言旧目标不变、后续未执行、资源清理。
- 分别注入 staging chmod 失败、staging chown 失败、prepare chmod 失败；断言非零、mv 未调用、旧目标不变、资源清理。正常路径使用真实文件 mode 核对；生产服务用户不能在本机测试时，owner 成功调用可用明确标注的受控替身，失败策略必须可执行验证，不在本机新建服务用户。
- 成功完整组装/发布：对 access 与显式/缺省 refresh 使用独立保存的预期值或旧副本与真实 dotenv 重载比较；不能将 OLD 与 TARGET 指向同一文件后拿自己比较自己。逐项核对完整非 JWT 字段集合及值，第二次执行仍一致。日志不输出样本值。
- 实际 caller 的错误传播需有证据：deploy.sh 对共享 assemble/publish 任一非零都会 fail、不会走后续步骤；测试不要只触发自制的与生产不一致的包装路径。

只重跑修改涉及的 lifecycle/deploy-flow 与静态检查。若未改解析/序列化，不必再跑 round-trip 18 项；原 unit/startup/Jest/PG 基线不重跑。不以追加测试数替代以上具体负例。

## 证据与停止

新日志/JSON/报告写 `phase3/evidence/P3-W0-T01/rework3/`。保留所有原结果，不覆盖旧日志/HASHES/PF 固定输出。仅追加必要更正索引，先完成报告再生成最终 hash 清单，最后只读复验。冻结 29 文件保持只读核验。

返回：STATUS；A/B 实现位置；每个上述用例的实际 rc/调用计数/旧目标 hash/资源清理；完整成功路径的重载比较；变更文件与最终 hash；未执行边界；ASTRA REVIEW HANDOFF。用例结果另存 JSON，日志采用不会损坏 UTF-8 的输出方式。

完成后停止，不关闭 AUD-044、不启动下一包、不提交/部署。发现超出 A/B 的设计要求先报告，不自行扩大实现。

## 模型与交接

CodeBuddy 沿用当前执行工具/模型；GPT 辅助有界实现可用 Sol / Extra High。下一轮 GPT 复审建议 **Astra / Extra High（极高）**，只核对 A/B 与已有验收边界。携带本包、ORCHESTRATOR_STATE 和完整结果，不重新全仓扫描。
