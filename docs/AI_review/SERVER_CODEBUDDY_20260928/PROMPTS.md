# 可直接粘贴给服务器 CodeBuddy 的提示词

先在服务器 VS Code Remote 打开**实际部署仓库**，确认服务进程指向该目录。每轮都将本目录 `README.md`、`FINDINGS.md`、`ONLINE_CHECKS.md` 加入上下文。以下提示词中的“执行”仅限明示范围；不能因审查便利改变生产数据或服务。

## R0：冻结真实部署基线（第一轮，必须先执行）

```text
你是服务器端独立代码审查员。请先读 docs/AI_review/SERVER_CODEBUDDY_20260928/{README,PROMPTS,FINDINGS,ONLINE_CHECKS}.md，再核对当前服务器的实际部署状态。此轮只读，禁止 git pull、安装依赖、构建、重启、迁移、修改数据库和提交。

1. 记录仓库路径、分支、HEAD、origin/Product_tencent_CVM SHA、git status、进程启动目录/可执行代码位置、systemd 配置与服务状态；若进程代码不是工作区 HEAD，明确 BLOCKED，禁止把工作区检查结论当线上结论。输出中不出现环境变量值。
2. 只读确认 Node/Prisma 版本、public 迁移台账、各 active/disabled 租户台账与链尾、当前 client 形状。先检查脚本源码和环境指向，再运行 node backend/sync-tenant-schemas.mjs --check 与 node backend/scripts/006_audit_principal_gate.mjs；记录 rc 和脱敏摘要。不要运行会写库的默认 db:sync。
3. 只读观察 /api/health 与 /api/readyz，分别记录状态码、就绪分类、global blockers 和 blocked schools 数量，不记录敏感数据。确认备份目录与导出目录的服务用户权限，只做 stat/读元数据，不运行备份或导出。
4. 检查 docs/AI_review 下将要提交的内容是否有凭据/个人数据；原始日志留仓外并限制权限。给出本轮基线表、风险清单、可复跑命令、未执行项。没有实证的点标“待验证”。

输出 R0 脱敏报告，填写 FINDINGS.md 的台账模板。此轮不要修代码。任何 P0 或线上不就绪立即停止新增探针并报告。
```

## R1：迁移、租户基线与发布链

```text
基于 R0 固定的实际运行 commit 深审 public/租户迁移与部署路径。只读审查源码；需要复现写入时只能在独立克隆库。重点读 backend/lib/{tenantProvisioner,tenantSync,publicInfraShape}.js、backend/sync-tenant-schemas.mjs、backend/server.js、backend/prisma/migrations、backend/scripts/{004_backfill_audit_principals.mjs,006_audit_principal_gate.mjs,b-release-two-phase.sh}、deploy/deploy.sh 与相关测试。

逐项追踪：旧库无 _tenant_migrations 的 baseline-plan → 人工修复 → baseline-apply；缺表与 nullable 唯一索引 NULL 语义；台账 checksum/失败/非终态；public-only 投影；锁/失权/并发；启动只读检查与流量阻断；M1/M2 和 client 两态；部署入口的真正调用顺序与失败中止。先说明当前代码的预期，再构造最小反例。对 B1–B3 的历史补丁必须在克隆库回归，不以提交消息为证。

报告每项“代码位置 → 触发条件 → 可观察结果 → 对线上影响 → 最小修复 → 回归测试”。只读或克隆库证据明确分栏。不要修改生产数据库，不要自动 resolve/db push/force unlock，不要把修复写入历史已应用 migration。
```

## R2：认证、会话与外部 OpenAPI

```text
基于同一冻结 commit 审查 authMiddleware、UserManager、session/吊销基础设施、openApiGrantIdentity、openApiRoutes、adminOpenApiRoutes 和相关测试。跟踪一次请求从 token/credential 到 school id+generation、授权、查询与响应的完整路径。

重点验证：跨校/同 code 重建、grant 缺身份/错世代时 403 与隔离、禁用/删除用户旧 token 不复活、AUTH_INFRA_MISSING 是否 fail-closed、管理端 preview/dict/samples 是否先授权后查租户、异常处理是否泄露数据。四条历史外部授权据称已交付使用；只读核对当前数据库状态与授权调用日志的脱敏指标，不擅自禁用、重授或向合作方发请求。需要写操作的反例在隔离实例执行。

产出外部合作方影响表：受影响 client/grant 数（不含密钥）、预期和实测 HTTP 状态、需要的重新授权/客户端 checkpoint 操作、协调窗口。不要在报告里放 credential、token 或真实请求体。
```

## R3：业务读写、隔离、审计与导出

```text
沿路由→服务→Prisma/SQL→租户 schema→前端调用追踪记录创建、更新、删除、统计、分页、同步和异步导出。审查 search_path、参数绑定、事务边界、幂等键、权限、租户归属、数据保全、任务文件权限和清理。

特别检查 AuditLog principal_id/actor_snapshot 的新旧数据语义、软删除墓碑与禁复活、跨租户同 ID 隔离、记录查询超限后的客户端处理、导出作业访问和过期清理。使用现有测试验证后，再在隔离实例做带负对照的最小写入反例。生产仅可在 ONLINE_CHECKS.md 的合成对象范围内做受控探针；没有专用对象就保持只读。

给每个发现附具体代码行、输入条件、预期/实际、是否可复现、数据是否变动和清理证据。不要用“看起来安全”代替可运行判据。
```

## R4：备份、恢复、外部注册与 ACL

```text
审查 backupService、restoreService、externalBackupRegistration、管理路由、003/004/006 脚本与测试。对备份来源、加密、sha256/大小、路径穿越/符号链接、元数据一致性、注册审计同事务、restore-from-upload 防伪造、staging align、失败保旧、ACL grant option 和受限角色实际访问建立用例矩阵。

真实恢复与故障注入只在独立克隆实例进行，绝不在生产做恢复/注册/删除。至少覆盖成功、篡改、无台账拒绝、M2 失败保旧、重复恢复、权限重放与清理。区分“代码静态推断”“测试替身”“真实 PG 克隆实例”三种证据，不把模拟环境通过写成生产结论。
```

## R5：已部署系统在线核验

```text
先确认 R0 的实际进程 SHA 仍相同，按 ONLINE_CHECKS.md 的顺序检查。默认只读：health、readyz、认证负例、经授权的租户业务读、OpenAPI 授权读、备份/导出任务元数据状态。每一步记录时间、路径模板、方法、账号角色类别、状态码、响应中的非敏感判据和退出码；不存 token/口令/客户数据。

对已交付外部使用的 OpenAPI，先查日志/指标和当前授权状态，再在双方协调的窗口做真实调用；不能因审查产生新的 scope_version 或禁用授权。只有已设定专用合成租户/账号、唯一标记和清理脚本，才可执行少量写入探针。任何 readyz 非 200、真实租户 API 503、外部授权异常、跨租户泄漏或数据损坏即停止后续写探针并升级处理。

输出线上通过项、失败项、未测项，不把 /health 200 当作 readyz 或业务可用证明。
```

## R6：独立复核与结论

```text
请以独立审查员身份复核 R0–R5 的结果，不接受此前模型的 PASS 作为证据。重取运行 commit 与变更状态；抽查 P0/P1 的原始脱敏证据和修复前后反例；逐项确认代码行、测试执行数、0 skip、克隆库/生产证据分栏、线上健康与业务探针、外部授权影响、恢复与回退口径。寻找此前轮次之间的矛盾、时间顺序错误、被覆盖的红日志或未经证明的结论。

按 FINDINGS.md 的状态给出可发布/需修复/阻塞结论。未验证的事项保持 OPEN 或 NOT_RUN，不用推测关闭。列出下一轮最小修复顺序和每项验收条件。
```

## F1：每个缺陷的修复与复核（R6 指定后逐项使用）

```text
只处理已登记的发现 <ID>，先复现并保存脱敏失败证据。说明根因、最小修改面、受影响生产数据、迁移/回退影响。先在独立实例修复并运行真正能区分修复前后的负例和相邻测试，记录 rc/执行数/skip；不要修改历史已发布 migration，也不要对生产做 destructive 验证。

提交前只 stage 该功能所需的源码+测试+必要文档，复核 git diff --cached、秘密扫描与远端 HEAD；按既定要求直接推 Product_tencent_CVM，不建立审阅分支、不 force push。生产部署是后续独立步骤：先备份和门禁，按实际部署入口执行，完成后重新跑 R0/R5。若修复涉及外部 OpenAPI 行为，先制定协调与重新授权方案。

输出修复前/后证据、提交 SHA、部署 SHA（未部署写 NOT_RUN）、残余风险。不要一次性混合多个无关发现。
```
