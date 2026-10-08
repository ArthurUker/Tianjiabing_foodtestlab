# P3-W0-T02A-R3 — Orchestrator review

日期：2026-09-25。裁决：**REWORK，仅生命周期 L 的剩余删除/归属分支**。AUD-039 保持 OPEN；AUD-044 保持 REMEDIATED_LOCAL / PASS。

总控只读复核 CodeBuddy 返回、源码、结构化测试结果和证据 hash；未执行测试、PostgreSQL 或部署，未改应用。R3 自报 PASS 的正常路径和回归记录有效，但不能替代以下未覆盖的危险分支。没有证据表明本轮实际误删数据；这里指出源码可达条件。

## 已接受的 R3 进展

- H1 深冻结已落在 `checkIsolationConfig` 的配置输出；顶层和嵌套篡改回归通过。
- H2 真实 `withVerifiedTenantTx` + 真实事务在同一 tx 内改变 search_path，真实共享核验返回 `RUNTIME_IDENTITY_MISMATCH`，传入业务 callback 为零；正例与前置拒绝各有计数。原 hook 中断已准确改名。
- H3 受控连接、管理员连接与 fixture 连接的失败释放均保留原错误和 release 错误；live-probe 的正常 release 观测通过。
- E 汇总器改为从 Jest JSON 中读取 passed 用例；entry-observer、并发部分提交与 probe 清理动作失败各自引用正确来源。逐实例 registry 不再把残留数写死为零。正常任务实例 up/status/down 的记录为一致归属、stop=0、进程消失、端口释放。
- L 的 probe 对 rc=1 且空 stdout/stderr 的 no-match、rc=0 空输出、畸形 PID 行、signal 已比 R2 严格。正常真实 up/down、stop 后探测不确定、start 失败无 pidfile 等回归通过；收尾 fixture 可在残留时返回非零。
- 输入快照 254：独立只读核验 **247 未变 + 7 授权变化 + 0 缺失/越权**；R3 HASHES_FINAL **49/49**；冻结清单 **29/29**。HEAD/branch 不变，index 空，累计 tracked 9 文件 +548/-257。落盘日志自报 isolation 42/42、integration 23/23、probe 28 必需 check、汇总 17/17；这是已执行用例的结果，不扩称危险分支全覆盖。

## L1：诊断输出仍可能授权 stop/delete

`tests/isolation/provision.cjs` 的 `probePid` 和 `probePort` 只在 rc 非零时检查 stderr。若命令返回 rc=0、stdout 为表面有效 PID、stderr 非空诊断，两者仍返回 present/listening。R3 包要求“非空诊断 → unknown”；若该输出进入 down，会参与 `ownEvidence` 并允许 stop。默认 spawn 包装还丢弃了 signal 字段；rc=null 会被拒绝，但不能在证据中声称实际 signal 已被传递和记录。需在真实包装和探测器保持一致的 unknown 语义。

## L2：已停止分支能绕过 pidfile 不一致并删除目录

`down` 的 `!a.ownEvidence && a.stoppedClean` 分支直接 `rmSync`，没有要求 pidfile 的 PID/datadir/startTime/port 与 ownership 一致。可达例：ownership 记录 PID P、端口 A；pidfile 记录不同端口 B 或不同启动标识；对 P 的 ps 是 no-match，对 A 的 lsof 是 no-match。`assessOwnership` 得到 `pidfileMatches=false` 但 `stoppedClean=true`，`down` 仍返回 `already_stopped_confirmed` 并删除目录。若实例实际以另一 PID/端口运行，探测旧值无法证明 data 已停止。R3 任务包要求这些不符场景零 stop/delete；现有测试只在记录 PID 和端口仍 present/listening 时篡改 pidfile。最保守的闭合方式是：没有完整自有证据时不自动删除；成功 stop 后再由三条件路径删除。

另有 `readOwnership` 仅要求 `rec.datadir` 为绝对路径，却只把 `rec.datadirReal || rec.datadir` 与任务 data 比较。原始 datadir 指向别处、datadirReal 指向任务 data 的矛盾记录仍可通过；这不满足 R3 包要求的两个路径字段互核。

## L3：up 异常收尾仍是第二套归属判定

`up` 的 catch 独立计算 `ownEvidence`，没有调用 `assessOwnership`。它不比较 ownership 记录的 PID、port、startTime、datadir，也未要求 pidfile 端口等于本次请求端口。只要 pidfile 可读、该 PID 的命令行带任务 data、被探测端口含该 PID，就会尝试 `pg_ctl stop`；即使 ownership 缺失或矛盾也是如此。R3 包明确要求 up/down/status 共用同一归属判定；start 已尝试而完整记录缺失时可以保守保留，不能根据另一套较弱的条件授权 stop。现有 start 非零用例覆盖无 pidfile/外来监听者，却未覆盖“pidfile 与监听看似一致，但 ownership 缺失/矛盾”。

## 唯一下一步

执行 [P3-W0-T02A-R4_REWORK_PATCH_PROMPT.md](P3-W0-T02A-R4_REWORK_PATCH_PROMPT.md)，先核验 [P3-W0-T02A-R3_REVIEW_INPUT_MANIFEST.json](P3-W0-T02A-R3_REVIEW_INPUT_MANIFEST.json)。只修改 `tests/isolation/provision.cjs` 与 `tests/isolation/lifecycle.test.cjs`，新增证据写 `rework4/`。H/E、真实跨库权限、W0-T01 与旧证据保持已接受状态；不接入 root/backend，不启动下一 wave。

执行者再次报告写入包外“工作记忆”，与任务包的明示范围不符。总控没有检查或清理私有记忆，也不把仓库 hash 解释成全机完整性证明；下包继续禁止这项操作。
