# R13 下一棒：窗口 3 限定返工

```text
执行 P3-LIFECYCLE-AB-R4（窗口 3 限定返工）。先读 docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md、docs/AI_review/Codex-GPT6/P3-LIFECYCLE-AB-R13_REVIEW.md、P3-LIFECYCLE-AB-R3/RESULT.md 与 TEST_RESULTS.json，以及 A/manifest.json、B/manifest.json。开工重新取输入快照、当前 16 文件链逐文件 hash、schema/client hash、冻结 29；旧 R3 证据与 HASHES 原样保留，新证据只写 P3-LIFECYCLE-AB-R4。兄弟窗口不得同时编辑链/client 或跑全量。

R13-1 修管理员读路径：backend/routes/adminOpenApiRoutes.js 的 GET /clients/:id/preview 与 GET /clients/:id/dict 必须复用同一 grant 身份判定，读取当前学校 id/generation；缺身份、孤儿、school_id 错配、世代过期一律 fail-closed，隔离写失败也不能放行。预览在拒绝前不得读取租户记录，字典不得下发旧授权字段。保留现有管理权限与合法 grant 的成功响应。补真实 HTTP 正反例（包含同 code 重建与隔离失败），逐入口留 rc。

R13-2 修 004 映射：映射证据按 (schema,audit_id) 精确匹配，不能用同一 audit_id 跨租户套用；重复/未知/过期映射行须拒绝。user_id 或 actor_snapshot.subject_user_id 已有稳定值时，不允许映射覆盖；冲突应非零拒绝并且相关审计行与 principal 零误写。映射文件每行需可核的证据来源与审批痕迹，记录文件摘要及行级绑定前事实，不能把“文件 SHA 正确”当成身份归属证明。补两租户同 audit_id、快照与映射冲突、同意映射、摘要篡改、重跑幂等的真实 PG 反例；旧 B 矩阵 23 项场景保留。

R13-3 统一 006 的 G3③/G3④ 空快照语义：SQL NULL、JSONB null、空对象如何判空在代码和文档中一致；人类 principal 绑定无主体且语义空快照的行必须 GATE_FAIL。补真实 PG 负例及修复后正例。若 G3 的其它主体不变量（system id/scope/kind）未纳入门禁，明确覆盖或列出局限。

R13-4 B 发布门禁：R3 的 B1→006→B2 是本地手动演练，不得写成 deploy.sh 已强制接线。提供可执行、可复现的两段发布入口或发布包装器，并用函数级沙盒证明：任一 --check/G2/G7/G8 非零时，绝不会生成或激活 B client、不会 restart；全绿才进入 B2；回退安装 A client 而 DB 不逆迁。不得真实部署。若无法在本包安全接线，明确 B 发布 BLOCKER，保留 A/B 数据合同局部通过结论，不用文字承诺替代执行门禁。

修 backend/prisma/schema.prisma:87 行尾空格，使 git diff --check rc=0。新证据内勘误：R3 的 HASHES_FINAL.json.phase='design-only'、TEST_RESULTS.json 的 ee80d133… 是旧/中途元数据；当前产品 16 文件 digest 以本轮独立重算为准，旧冻结文件不改。复跑 A 33、B 23、受影响 Jest 111、openapi-http 12 与新增判别用例（计数变化逐项归因；0 skip），必要时自有新实例；不跑全套件。收尾冻结 29、逐文件输入漂移、HASHES_FINAL 双复验、实例 down 四条件、明文停止与是否释放 migration/client 面。

窗口 4 的双实例真实恢复继续 HOLD，待本包返工完成并由总控复核后另发启动信号；窗口 5 单实例全量回归仍最后执行。不得 reset/clean/stash/checkout、stage/commit/push，也不得真实部署。
```
