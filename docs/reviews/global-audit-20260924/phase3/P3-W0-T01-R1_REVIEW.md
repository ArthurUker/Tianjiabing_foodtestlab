# P3-W0-T01-R1 — Orchestrator review

日期：2026-09-24。裁决：**REWORK，仅部署接入与证据收尾；已通过的 R1 三类修订保留。**

Preflight PASS 保持，AUD-044 尚未验收。审阅只读实际 diff、解析/选择/CLI/shell/测试代码、原始日志及 hash；未代跑应用、测试、数据库或部署。

## 已通过的修订

- 文件有效值与原始环境值分开处理；配对引号/注释/空格解析后校验，共享选择/序列化模块落地；部署特殊字符限制没有扩到直接环境注入的合法值。
- 真实 dotenv 重载、两次 round-trip、jwt.sign/verify、缺省/显式 refresh 的对应测试与日志具备；未知参数与混合 help 不再回显参数。
- 启动测试使用合成 dotenv、读取拒绝检查与回环监听；受控依赖范围明确。npm 使用临时 runner 的 npm start，其 server.js 是真实的；仓库自身 package scripts 的转发关系是静态核对，不能称本轮运行了原根 package 的完整 npm start 链。
- 日志核对：unit 29/29、round-trip 18/18、deploy 42/42、startup 10/10，均 UTF-8 可读、0 fail/skip。原 Jest 38/40（历史两项）按包未重跑，继续接受。
- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；index 空；4 tracked 文件累计 +71/-27。冻结 Phase 1/2 manifest 29/29 仍一致。

## D1 — 新库依赖未接入受支持的首次部署方式

`deploy/README.md:44–48` 仍要求只上传 deploy.sh 与适配模板到独立 `/opt/deploy/`。新 `deploy.sh:39` 与 `:427` 却 source `$SCRIPT_DIR/lib/jwt-config.sh`，该库不会由上述两文件上传命令带过去，也不能指望稍后 clone 到另一 REPO_ROOT 自动补到 SCRIPT_DIR。

同时脚本只有 `set -o pipefail`，source 失败没有 `|| fail`，环境覆盖函数缺失也未检查返回码；缺库时脚本仍可继续至安装/PG/clone 等步骤，直到较后的 prepare 调用失败才退出。

这是具体受支持入口的兼容缺口，并非要求执行真实部署。应更新最小分发清单并在任何部署副作用前检查库存在、成功加载及必需函数。harness 当前直接 source 仓库中的库，未覆盖两文件上传的缺库路径。

## D2 — 新密钥临时片段及写回失败未完整处理

`deploy.sh:428` 新建 JWT_FRAGMENT，prepare 成功后含有效密钥。其清理仅在 prepare 失败或正常 cat 后执行，没有 EXIT/信号清理；例如紧随其后的“缺少备份密钥”既有分支 `exit 1` 会留下新 fragment。本包无需修该分支的既有 err 命名问题，但新增资源必须在该退出路径被清理。

写回又被改成三段：先 `cat > BACKEND_ENV` 截断旧文件，再 `cat JWT_FRAGMENT >> BACKEND_ENV`，删除 fragment，再追加剩余内容。各步错误未检查；片段读取/追加失败时仍可能继续后续流程，旧配置已被截断。这破坏本包要求的有效值保存与失败拒绝。源码路径已确认，未对真实配置做故障实验。

限定补丁：注册精确归属的临时资源清理；同目录受保护临时文件组装完整 env，确认成功及权限后再替换目标，任何一步失败保留旧文件并停止。harness 调用真实共享组装/发布路径并注入故障，不能只用 persist 次数替代。

## E1 — 最终 hash 报告与当前落盘内容不一致

本轮独立比对原 90 文件输入快照，实际变化 **14** 项；报告称 13。额外项为 `evidence/P3-PF-T01/manifest-verify.json`，其 checked_at 已更新为 `2026-09-24T13:57:01.620Z`。该校验脚本实际上会覆盖这个固定输出，不能当纯只读脚本使用。原 Phase 1/2 的 29 文件本体 hash 仍全匹配；不将此扩大为所有审计证据损坏。

R1 HASHES.json 的 22 个输出中，当前 W0 `RESULT.md` hash 也不匹配。应在全部报告写完后生成最终快照，准确记录固定输出覆盖这一流程偏差。不删改旧快照/日志、不编造原内容；若无可靠副本恢复，不强行拼造原 timestamp，保留当前副本并记录旧/新 hash 即可。未来校验结果只能写当前任务新目录。

## 退出要求

执行 [P3-W0-T01-R2_REWORK_PATCH_PROMPT](P3-W0-T01-R2_REWORK_PATCH_PROMPT.md)。只补 D1/D2 与 E1，不再重写已接受解析器/认证规则或扩大测试范围，不启动 AUD-039。新输入快照见 `P3-W0-T01-R1_REVIEW_INPUT_MANIFEST.json`，用于保护本轮审阅基底；获授权的文件在补丁中可以修改。
