# R18：只发原窗口 5 的 CLOSE-B R4 独占全量复跑

```text
执行 P3-CLOSE-B-R4（原窗口 5；不是新开第六窗口）。先读 docs/AI_review/Codex-GPT6/P3-R18_CONTRACTS_REVIEW.md、P3-CLOSE-B-R17_REVIEW.md、evidence/P3-CLOSE-B-R3/{RESULT.md,BLOCKERS.md,COMMANDS.md}，以及 F/L/P 三包最新 RESULT 与 STOP_SIGNAL。F=P3-FIXTURE-CONTRACT-R4，L=P3-LIFECYCLE-CONTRACT-R7，P=P3-PUBLIC-INFRA-TESTS-R2，三窗均已停止。旧 R3 runner/证据/HASHES 原样保留；新建 evidence/P3-CLOSE-B-R4/ 与 R4 runner。只编辑本窗口 runner/入口编排、必要的新证据；产品代码、迁移、schema/client、F/L/P 测试与旧证据不越界修改。

开工固定 HEAD/index、冻结 29、16 文件迁移逐项 sha/bytes 与产品 chain digest 03993cf9…、M2 ad389937…、B client d8a10fd1…、004、006、restore、三包修复源 hash；若任何关键输入与当前证据不符，先登记漂移，不沿用旧绿结论。独立运行 test:entry-audit，要求 24/24 且 backend 46 文件全部收录，0 skip。

修 B-7：R4 runner 必须在 W3 instance fixture 成功产出 env 后再读取该 env 文件，不能在模块加载时预读空 w3Env。显式向 W3REG PG 测试传 W3REG_ADMIN_DATABASE_URL（从同实例 W3_ADMIN_DATABASE_URL 映射）、BACKUP_DIR、BACKUP_MASTER_KEY；逐项核对 URL 的 runId/端口/DB/管理角色、目录/密钥属于本次隔离实例。缺一项非零拒绝、不得 skip；凭据不写入证据。保留 registry 的真实 PG 测试与来源 fail-closed 断言。

使用全新独占实例，按已实证的先后关系准备：provision up（public 16 链）→ T02B fixture 必须是第一个创建学校的 fixture → T02E fixture → root DB Jest（传 T02B_FIXTURE_FILE）→ live-api（必须早于 report-auth fixture 与学校 B 业务写）→ W3 instance fixture/学校 B 与 report-auth fixture（按各自前置合同）→ 其余正式入口。R17 旧 prompt 中“T02E 先于 T02B”已被 F 的干净实例推翻，不得照抄。任何试跑污染实例就整体销毁重建，不用手工 SQL 拼绿。

在同一干净实例执行全部正式入口：root DB、unit、integration、isolation、live-api、report-auth、session、单次 test:backend（46 文件，含 W3REG PG 真库例）及入口审计；逐文件对账“应执行=实际执行”，所有 rc=0、0 skip。核对 readyz=200、真实租户 API 200、db:sync --check、006 GATE_PASS；保留缺 TEST_DATABASE_URL/TEST_DB_CONTEXT_FILE 的 fail-closed 负例。特别复核 B-1…B-6 在组合运行下不再复发及 B-7 独立闭合。004 双会话证据已由 L 8/8 完成，复用其原始证据，不把同事务 hook 或本次未跑项目写成复测通过。

逐入口落原始 stdout/stderr、rc、执行数与 skip 数；若有红，按 known/preexisting/new 与依赖级联分栏，停止 PASS 主张并给归属，不改产品闸门或受保护断言凑绿。收尾核对输入 hash、冻结 29、git diff --check、HASHES_FINAL 生成后双进程只读复验；实例 down、端口/PG 会话/凭据文件零残留。全绿且证据齐全才可自报 PASS_LOCAL_REGRESSION；本轮不 stage/commit/push、不部署。deploy.sh 两段接线、真实发布/回退和生产授权仍另验。明文停止并交总控复审。
```
