# 服务器 CodeBuddy 多轮代码审查与上线核验

本目录是**审查作业说明**，不是已经完成的审查结论。执行者在服务器 VS Code Remote 中使用 CodeBuddy，先确认正在运行的代码和数据库状态，再按轮次审查、复现、修复和核验。服务器当前真实状态优先于本文中的历史交付回执。

## 使用顺序

1. 先读本文件、[PROMPTS.md](PROMPTS.md)、[FINDINGS.md](FINDINGS.md)、[ONLINE_CHECKS.md](ONLINE_CHECKS.md)。
2. 在 CodeBuddy 中依次粘贴 `PROMPTS.md` 的 **R0 → R1–R4 → R5 → R6**。R1–R4 可在相同冻结 commit 上并行**只读**审查；生产代码修改、数据库操作和部署必须串行。
3. 每轮输出脱敏结果与可复现证据，登记到 `FINDINGS.md` 约定的台账；独立复核者验证严重缺陷和修复结论。
4. 修复使用 F1 提示词，**一项风险一个修复单元**；经过克隆库/隔离实例与受影响测试后再走生产发布。线上只执行 `ONLINE_CHECKS.md` 允许的探针。

## 审查范围与优先级

| 轮次 | 重点 | 必须追踪的风险 |
| --- | --- | --- |
| R0 | 部署基线、生产只读状态、证据保护 | 工作区 HEAD 是否等于进程实际代码；服务用户、配置、数据库和备份路径是否一致 |
| R1 | Prisma public/租户迁移、baseline、readiness、部署脚本 | 无台账旧租户接入；失败保留现场；`--check`/006 门禁；版本与 client 顺序；多租户流量 503 边界 |
| R2 | 登录、会话、吊销、OpenAPI 授权 | 已交付外部使用的授权：升级前后 403、身份世代、重新授权、checkpoint/客户端通知 |
| R3 | 业务写入、租户隔离、审计主体、导出 | 跨校读写、软删除/禁复活、审计主体不可误绑、异步导出权限与清理 |
| R4 | 备份、恢复、外部备份注册、ACL | 完整性/来源、失败保旧、权限重放、跨实例；只在克隆库做真实恢复 |
| R5 | 线上只读和受控合成业务探针 | `/readyz`、真实租户 API、第三方 OpenAPI、后台作业；逐探针记录响应与回滚 |
| R6 | 独立复核与收口 | 复现每个 P0/P1、审查修复 diff、重跑边界用例、确认无未归因红项 |

## 执行边界

- **生产审查先只读。** `git status`、代码读取、`db:sync --check`、006 门禁、受控 GET/HEAD 与只读 SQL 可先做。不要在生产上运行 `migrate deploy`、无参数 `db:sync`、`--baseline-apply`、`--force-unlock`、恢复、清理、批量压测或攻击性扫描作为“检查”。
- 需要验证迁移、备份恢复、故障注入或跨租户写入时，使用**生产备份的隔离克隆**或专用测试实例；记录其实例标识、端口、数据库、代码 SHA、清理结果。克隆前确认备份加密与数据访问范围。
- 生产上的业务写探针须使用专用合成租户/账号，写入量上限、唯一标记和逐项回滚/清理预先写清；涉及真实客户或第三方调用的验证，以现有业务观测和经协调的合作方测试窗口为准。
- 发现 P0（数据泄漏、跨租户越权、数据损坏或全站不可用）立即停止新增写操作，保留证据并先止损。P1 以上未关闭前不宣称全面通过。
- CodeBuddy 的聊天、工具输出、报告、提交记录和 GitHub 文档均不得包含数据库 URL 中的口令、token、`BACKUP_MASTER_KEY`、真实个人信息、备份文件或未脱敏请求体。原始日志存仓外、限制权限；入库只放脱敏摘要与 hash。
- 本地提交/推送按用户既定要求直接使用 `Product_tencent_CVM`，不创建审阅分支；一次只提交同一功能的源码、测试和必要文档，禁用 `git add .`。推送前核对远端未被其他窗口推进，禁止 force push。**推送不等于生产部署。**

## 每轮交付与通过口径

每轮记录：实际运行 commit/进程版本、审查范围、执行命令或 HTTP 方法、退出码、测试执行数/skip 数、匿名化证据位置、发现列表、未覆盖项、结论。结论只能是 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`；静态检查不能冒充线上验证，克隆库成功不能冒充生产成功。

完整收口需同时满足：P0/P1 为 0 个未解决；P2 逐项明确处置与负责人；R0–R6 证据可复核；迁移/恢复风险在隔离库验证；受影响测试及入口清单全绿且 0 skip；线上 `readyz=200`、关键租户真实 API 与外部 OpenAPI 合同通过；备份/回退方案与实际版本吻合；敏感信息扫描通过。每次生产部署后重新执行 R0 与 R5，不沿用旧绿灯。

## 已知的核对线索（均须重新验证）

- 当前仓库提供 `/health`、`/api/health`、`/readyz`、`/api/readyz`；`backend/sync-tenant-schemas.mjs --check` 和 `backend/scripts/006_audit_principal_gate.mjs` 是只读门禁入口。先核代码和服务实际版本，再用它们。
- 历史服务器克隆预演曾发现 baseline B1–B3；GitHub 后续提交 `83bce2a` 声称修复。R1 必须用当前部署版本及隔离克隆验证，不能仅凭提交消息关闭。
- 历史部署检查确认 OpenAPI 授权已交给外部系统使用。R2/R5 应确认四条历史授权的**当前**状态和合作方调用结果；不得为测试而禁用或重新授权真实记录。
- 历史 `deploy/deploy.sh` 先生成 Prisma client 再迁移；另有 `backend/scripts/b-release-two-phase.sh`。审查实际生产采用哪个入口、版本顺序和失败中止行为，不能把沙盒通过当作生产发布验收。

CodeBuddy 官方入口参考：[Agent Mode](https://www.codebuddy.ai/docs/ide/User-guide/Agent-Mode/Quickstart)、[VS Code 集成](https://www.codebuddy.ai/docs/cli/ide-integrations)、[工具与结构化发现](https://www.codebuddy.ai/docs/cli/tools-reference)。生产服务器上不要为审查额外启用公开分享或远程控制通道。
