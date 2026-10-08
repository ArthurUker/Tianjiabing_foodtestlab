# P3-W0-T01-R2 — Orchestrator review

裁决：**REWORK，仅 D2 未闭合；D1/E1 接受。** 日期：2026-09-24。

总控读取实际源码、diff、harness、日志和 hash，未运行应用/测试/部署。Preflight PASS 保持，原解析/签名兼容/隔离结论保持；不重新全仓审计，不发 AUD-039 包。

## 已接受

- D1：新增库分发清单与真实入口检查已接上，发生在适配配置读取及系统操作前；source/函数缺失被拒。正例证据只表示依赖加载后在必填配置检查处停止，未宣称完整部署。
- E1：独立重算 HASHES_FINAL 的 19 条均匹配；冻结 manifest 29/29 匹配。相对上轮 103 输入仅 7 个既有路径发生授权变化；PF 的 manifest-verify.json 未再变化。此前固定输出覆盖已如实记录，无需再返工 E1。
- 日志显示 lifecycle 汇总 68/68、deploy-flow 42/42、round-trip 18/18。EXIT/TERM 的登记文件清理、未登记对象保留及成功生成 600 临时文件有已记录证据。
- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；index 空；5 tracked 文件累计 +146/-35。

## D2 剩余 1：生产组装未检查写失败，测试组装却检查了

`deploy.sh:538` 的 prefix heredoc 与 `:549` 的 suffix heredoc 都没有检查 cat 的返回码。脚本只启用了 pipefail，没有全局 errexit。后续只查 NODE_ENV/DATABASE_URL/CORS_ORIGIN/JWT_EXPIRE 四行是否存在。

具体反例：suffix 写出 JWT_EXPIRE 与 CORS_ORIGIN 后，后续 SEED/BACKUP/TENCENT 字段写入失败，cat 非零；当前代码忽略非零，四行检查仍通过，publish 可以将半截配置替换为正式 env。这不是要求新增发布事务，而是原 R2 明确要求的“每一步组装失败不得发布”。此为源码控制流结论，未制造真实磁盘故障。

`deploy-distribution-lifecycle.test.sh` 的 assemble_and_publish 是测试内另写的组装路径，prefix/suffix 的 printf 都有 `|| return`，与生产缺少判断的 cat 不同。它仅镜像少量字段，并未调用真实共享组装函数，违反上包“真实 deploy 与测试共用组装/发布”的明确要求。68 个检查无法覆盖这个生产错误。

此外 B1 的 OLD1 与 TGT1 是同一路径，第一次 access 比较实际上将同一个已覆盖文件与自己比较；应改为独立保存的预期有效值/旧副本。B3 的不存在目录/目录目标属于发布前检查，不等同于对真正 mv 失败的注入。

## D2 剩余 2：权限/属主失败仍在发布之后被忽略

`jwt_config_publish_env:100–110` 先 mv，随后 chmod/chown 失败只警告，最后 return 0。这与“权限建立成功后再替换；失败旧文件不变”的原验收要求相反。尽管正常 staging 由 make_secure_tmp 创建为 600，指定服务用户的 chown 仍可能失败，不能承诺此时发布成功。

`jwt_config_prepare` 也仍有 `chmod 600 ... || true`，当前 S5 只检查主脚本是否有这一字符串，没有检查真实库行为。应显式处理这些剩余失败，在发布前完成所需权限/归属检查，再以 mv 作为最后改变目标的步骤。

## 证据口径

原 lifecycle 日志局部存在非 UTF-8 字节，68/68 汇总可读；保留原文件，新执行同时记录结构化退出码与检查结果。本项并不要求单独重跑 D1/E1。本次未因日志编码问题否定已确认事实。

## 下一步

只执行 [P3-W0-T01-R3_REWORK_PATCH_PROMPT](../../reviews/global-audit-20260924/phase3/P3-W0-T01-R3_REWORK_PATCH_PROMPT.md)：真实共享组装、发布前权限/属主检查及对应真实故障注入。不得扩大为全部署重构、数据库回归或完整事务回滚。
