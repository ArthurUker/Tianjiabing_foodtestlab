# P3-W0-T01 — Orchestrator review

日期：2026-09-24。裁决：**REWORK（限定本包）；AUD-044 未验收，不发下一个 remediation 包。**

Preflight PASS 保持有效。本次为应用修复包复审，不重启全仓审计。直接读取 tracked diff、新模块/CLI/shell/test/stubs、报告及四份日志；没有执行应用、测试、部署或数据库操作。

## 已确认并保留

- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，index 空；4 个 tracked 文件 +57/-24；另有本包新增源文件/测试/文档。
- 共享校验模块与 server.js 接线确实存在；拒绝在 server 主流程 Prisma 构造与监听前，access/refresh 共用规则，无 NODE_ENV 放行分支。UserManager/算法/派生未改。
- 单测日志 20/20；启动日志 8/8；部署 harness 汇总 33/33；指定 Jest 38/40，失败名称/断言/行号对应原 DS3-M2/M3。它们证明已覆盖的样例通过，不证明下面未覆盖的值流安全。
- Phase 1/2 manifest 29/29 独立计算一致；冻结分析没有被修改。三个餐具 delta 未触碰。

## R1 — 校验输入与运行时有效值不一致（必须修）

`deploy/lib/jwt-config.sh:14–19` 只取第一个 `KEY=` 后面的原始文本。它不解析 dotenv 引号/注释/空格/重复定义，也将读失败与缺失混用。`deploy.sh` 随后以未转义行写回这些文本。

可直接从代码与当前已安装的 `backend/node_modules/dotenv/lib/main.js:9–40` 推导：

- 旧文件 `JWT_SECRET="please-run-openssl-rand-hex-32-and-replace-this"`：部署校验收到带引号的长字符串，不命中名单；写回后 dotenv 去引号，实际有效值成为被禁止的公开值。最终 server guard 会拒绝，**因此不能声称它绕过了 server guard 或已签发弱 JWT**；但“部署写文件/重启前拒绝”已不成立。
- 旧文件 `JWT_SECRET="<安全生成值>"` 与裸值加 inline comment：校验的是不同字符串；当前字节保留测试只比较 shell 变量，没有比较运行时加载后的有效值。
- 环境注入包含 `#`、引号或反斜线等特殊内容的合法原始字符串，未转义写回后可能被 dotenv 截断/去引号/解释；同一配置在不同入口可能改变签名用字节。已传入环境的值与 dotenv 文件语法不可混为一层。
- 旧文件键格式未被 grep 识别或读取出错时，会被当作缺失自动生成 access，存在非预期轮换风险；需明确支持语法与拒绝行为。

部署 harness 的 persist 只是 `echo x`，未走真实 JWT 序列化/重载；D1/D2 也从“已合并变量”开始，未验证真实环境优先级。D14 只验证函数返回，未验证 optional refresh 未绑定时的实际写回。

## R2 — 错误参数/操作示例泄漏边界（必须修）

`backend/scripts/validate-jwt-secrets.mjs:26` 原样输出 `args.join(' ')`。误把合成或真实密钥作为 CLI 参数时，错误日志会重复泄漏该值，违反不输出值/子串的契约。应固定用法错误消息，不回显任意参数。

`docs/JWT_SECRET_CONFIGURATION.md` 的 `sudo -E JWT_SECRET='<生成值>' ...` 将赋值作为 sudo 参数，与文档“不进 argv”目标冲突。改为从受控环境继承的说明，不把真实值放入命令行参数或示例执行记录。测试 harness D14 也将生成的合成值经 `$2` 传给 bash；这里只是测试样本，不能作为生产无 argv 方案的证据。

## R3 — 启动测试仍可能读取真实 .env（必须修）

`startup-jwt-guard.test.mjs:43–48` 使用仓库根 cwd；npm start 再切到 backend。真实 server 调用 dotenv.config，测试 loader 没有拦截/限定 dotenv。白名单进程环境不会阻止默认读取真实 repo/.env 或 backend/.env。当前缺失配置样例通过不能证明未来运行不读取这些文件。

按原任务要求将 dotenv 查找限定到任务自有合成文件/目录，并用拒绝默认查找的断言验证。可以通过测试专用 loader 重定向到真实 dotenv 的合成路径；不能增加生产绕过开关。正例监听也应由测试层拦截或限制回环，不扩大到真实对外服务。

## 报告更正（不新增独立返工范围）

- 部署日志含 8 个无法按 UTF-8 解码的字节，几处 rc 文本损坏；33/33 汇总仍可读。保留原文件，新日志完整保存，机器 JSON 单列真实退出码。
- server/报告的部分行号不准确；更新以实际 diff 为准。没有在实施前单发清单不是需要用户追认的权限问题，本包已经授权实施；不据此要求额外审批。
- 纯函数成功只说明输入值验证；启动替身不等于 systemd 实测；部署计数 spy 不等于完整写回重载验证。按新增证据缩紧结论。

## 下一步

仅执行 [P3-W0-T01-R1_REWORK_PATCH_PROMPT](P3-W0-T01-R1_REWORK_PATCH_PROMPT.md)。保留当前应用改动作为补丁基底，不能 reset。原日志/hash 先钉住，新日志写 rework/；不重跑三套 PG 基线、不改历史失败、不启动 AUD-039。
