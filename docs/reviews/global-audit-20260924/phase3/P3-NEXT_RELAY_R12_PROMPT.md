# R12 下一棒：仅窗口 3 生命周期 A/B

将下方整段发给窗口 3。窗口 1、2 已完成并停止；窗口 4、5 保留既有任务与等待条件。

```text
执行 P3-LIFECYCLE-AB-R3，续作 P3-LIFECYCLE-AB-R2 的生命周期 A/B 实施。先读 docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md、docs/AI_review/Codex-GPT6/P3-FIXTURE-14CHAIN-R12_REVIEW.md、phase3/REVIEW_LOG_MASTER.md §0/§4、P3-LIFECYCLE-AB-R2 的 PLAN_A_R2.md / CLIENT_STRATEGY_R2.md、P3-LIFECYCLE-AB-R1/MAPPING_DELTA_R9.md、P3-W2-LIFECYCLE-DESIGN-R5/DESIGN_R5.md。核对 P3-PUBLIC-INFRA-FOLLOWUP-R1/STOP_SIGNAL.md 与 P3-FIXTURE-MIGRATED-R3-14CHAIN/RESULT.md §8 的明文停止信号，开工前重取 HEAD/index/输入快照、冻结 29 与共享面 hash。

A-0 链口径：对旧 14 个 migration 逐文件核对 name/SHA-256/bytes 与 CHAIN_TAIL_LOCK.json，旧文件一字不改；新 migration 只追加在 20260927120000_public_infra_field_option_self_fk 之后。注意锁文件的 chain_digest=4e8595bb… 与产品 migrationChainDigest()=88a2ba45… 不相等，原锁未声明聚合算法。分别标注两种值，不得把锁聚合值当产品台账预期值、不得改写旧冻结证据；在自有实例核对台账 chain_digest 与当时产品算法一致。若逐文件 hash 或产品台账不一致，保留原始 rc 并停止依赖它的迁移回放；仅聚合值口径不一致则登记，继续基于逐文件锁实施。

你现在独占 schema.prisma、新增链尾 migration、Prisma client 的编辑/生成和迁移回放面。正式授权最小跨面：backend/routes/auditRoutes.js 的审计筛选双来源；backend/tests/http/openapi-http.integration.test.mjs 的直建 grant 身份字段；tests/auditUserFilter.test.js 原场景保留并注释溯源。openApiRoutes.js/adminOpenApiRoutes.js 只改 grant 身份校验相关 hunk，W5 遗留只读分叉按开工快照保护。其他跨面先列出文件、行区、必要性与归属，不能默默扩张。故意未提交的兄弟工作树不得 reset/clean/stash/checkout，不 stage/commit/push，不真实部署，不跑全套件。

Release A 独立交付：新增 M1 expand 与 A 版 nullable schema/client，解除 AuditLog.user_id 级联；M1 含 CHECK (principal_id IS NOT NULL) NOT VALID，使旧行可枚举而新 INSERT/UPDATE 必须绑定 principal，不能靠 created_at 水位替代。审计写入在同事务绑定不可变主体；无主体且无快照才用 system principal；历史人类事件仅凭稳定 subject_user_id 或独立可审映射证据绑定，username-only 一律拒绝。读路径兼容旧 NULL 行、user_id/principal 双来源过滤；grant 读时身份缺失/错配必须 fail-closed，同 code 重建不得继承旧授权。用空库/旧库、active/disabled/新校、旧时间导入、W1 epoch 同事务、受保护测试场景和单次 staging align 保旧等真实正反例验收 A。A 要有独立 schema/client/迁移补丁、输入快照、逐入口 rc 与 hash，未满足不得称 A 完成。

Release B 用可核验的双产物方案：B1 仍用 A 版 schema/client，仅追加 004 数据回填和自足 M2 migration；在独占实例中证明 M2 对旧备份 staging 的唯一一次 align 可在切换前完成，失败保旧。B1 之后执行只读强门禁：db:sync --check、全租户 G2(principal_id NULL=0)、G7(attnotnull=true)、G8(CHECK 已 validated)；输出不达标租户并非零拒绝。门禁全绿才生成/激活 B2 required schema/client。提供两份可重建产物或补丁及各自 manifest、真实生成顺序、门禁失败不得激活 B2 的反例，以及回退到 A client 而 DB 保持 M2 的演练；不得用最终工作树同时有 A/B 文件代替分阶段证据。deploy.sh 本轮不改。如实际发布流程无法强制 B1→门禁→B2，就把 B 标为 blocker，不得宣称完成；仍先完成可独立验收的 A。

逐项记录原有失败/新失败/skip，不硬套旧总数。自有实例和台账独立，记录源文件测试前后 hash、冻结 29 只读核验、输入漂移逐项归因、HASHES_FINAL 双复验、实例 down 四条件。交付 RESULT/COMMANDS/TEST_RESULTS、A/B 阶段补丁与证据及未决项，明文说明是否释放 migration/client 编辑面。窗口 4 的双实例恢复须等本窗口完成并明文释放；窗口 5 的单实例全量回归须等窗口 4 完成并经总控另发信号。
```
