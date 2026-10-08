# P3-LIFECYCLE-AB-R4 限定复审（R14，2026-09-27）

## 裁决

**REWORK（限 004 映射证据与 M2 系统事件空快照）；窗口 4 双实例真实恢复继续 HOLD，窗口 5 全量回归继续 HOLD。** R13-1 管理端身份守门、R13-3 的 006 双向判据、R13-4 函数级发布沙盒在各自范围内通过；R4 自报的四项“全部闭合”不成立。窗口 3 已停止并释放编辑面是资源事实，不替代此质量裁决。

## 独立核验

- 交付清单 `verify.mjs hash --verify HASHES_FINAL.json`：**61/61 ALL_MATCH**；冻结 29 只读核验 **29/29 ALL_MATCH**；`git diff --check` rc=0。
- 当前 16 文件链的产品 `migrationChainDigest()` 为 `844a5506d98a4d8d9de2f5f1d7ce3ac23a5c3adf3f74bc8f8b8358206d78bf91`，与 R4 `TEST_RESULTS.json` 一致。R3 的摘要按勘误保留为历史时点。
- 独立重跑 `node --test backend/tests/lifecycle/r13-release-gate.test.mjs`：**7/7 rc=0，0 skip**。R4 原始日志记录真实 HTTP/PG 17/17、A 33/33、B 23/23、Jest 111/111、OpenAPI HTTP 12/12；干净小实例 `db:sync --check` 1 校 16/16 rc=0，两实例 down。上述定点证明已测路径，不证明未覆盖的映射陈旧态或 M2 空快照态。

## 已闭合的 R13 项

1. 管理端 `preview`、`dict` 及声明扩展的 `samples` 在租户数据读取前复用 `classifyGrantIdentity`，读取当前学校 `id/generation`；缺身份、错配、孤儿、世代过期及隔离写失败均拒绝。真实 HTTP 日志 `R13-1.1…1.6` 覆盖合法 200、无 schema 时 403、同 code 重建及重授。
2. 006 的 G3③/G3④ 共用 SQL NULL、JSONB `null`、`{}` 的空快照语义，M2 的 4.5 人类主体 provenance 补齐也使用该谓词。真实 PG 日志 `R13-3.1…3.4` 覆盖三种空值与修复后通过。
3. 新 `b-release-two-phase.sh` 的 `b1`/`b2`/`rollback-client` 在 PATH 桩沙盒中证明门禁失败不生成/激活 B client、不重启。**仅为可执行顺序和本地沙盒结论**：`deploy.sh` 未接入该入口，真实发布编排及回退仍未验收；不得称生产发布门禁已接线。此部署边界与窗口 4 的隔离恢复测试可分开验收。

## 仍须返工

### R14-1：004 的“陈旧映射拒绝”仍可绕过

`004_backfill_audit_principals.mjs:91-96,138-145` 只在 `pre`、`valid_until` **提供时**校验；两者均缺的映射只要填任意 `evidence/approved_by/reviewed_at` 字符串并重算文件 SHA，即可进入预校验。`validateMappingAgainstDb:128` 对 `principal_id` 已非空的目标直接 `continue`，不核对它是否仍绑定到映射指定的 `subject_user_id`，也不核对 `pre`。因此“过期/陈旧行整体拒绝”的强断言只对已附可选字段且尚未绑定的子集成立；重跑换一份相反主体的映射也会返回成功。现有 R13-2.6/2.7 负例只覆盖**提供了**过期字段、缺审计字段或未知目标，未覆盖这个反例。`(schema,audit_id)` 定位、稳定 `user_id`/快照优先及已测冲突拒绝可保留。

限定修复：将行级绑定前事实作为 P-2 必填合同（至少包含完整 actor_snapshot 的规范化摘要、user_id 与 principal_id，明确序列化口径；可选到期字段不能成为唯一陈旧判据）；已绑定目标须验证当前 principal 的 `scope_key/subject_user_id` 与映射一致，匹配才允许幂等重跑，不匹配整体非零拒绝。补真实 PG 正反例：缺 `pre`、审计行事实变化、已绑定同主体重跑、已绑定异主体重跑、两租户同 `audit_id`；冲突时记录审计行/主体的前后计数与 hash，证明零误写。若脚本允许并发写入，绑定 UPDATE 还须按预校验事实做条件保护并检查影响行数，避免校验后变化造成误绑。

### R14-2：M2 的 P-4 与 006 的“语义空”不一致

M2 `migration.sql:64-70` 将 `user_id IS NULL` 的系统事件绑定到系统 principal 时，只接受 `actor_snapshot IS NULL`；同文件 4.5 和 006 均把 JSONB `null`、`{}` 判为语义空。对 `principal_id NULL / user_id NULL / actor_snapshot='null'::jsonb` 或 `{}` 的历史系统事件，004 可以按 P-4 处理，但**单次 staging align 的自足 M2 会留下残量并在 :82-95 抛 `M2_UNBOUND_PRINCIPAL_ROWS`**。这不是错绑，却否定了 R3/R4 所称“无需 004 的 M2 自足”在该已采用空值口径下的完整性。

限定修复：P-4 使用与 006/4.5 相同的语义空谓词；SQL NULL、JSONB `null`、`{}` 三类在未跑 004 的新 staging 上都应一次回放绑定系统主体并通过 G2/G3/G7/G8；真实非空人类快照仍保持未绑定并 fail-closed。修订 M2 前核实本会话与可见证据是否表明旧 checksum 已进入共享/生产环境；若无法排除，先报告版本兼容阻塞，不能仅追加一条在 M2 后的 migration（M2 会先失败，后续文件跑不到），也不能静默改已应用历史。若确认仍仅为未发布的本地链，再修 M2 并逐文件重算 checksum、产品链摘要、重跑受影响 B/恢复定点；R4 冻结证据不改。

## 接力

先执行 [P3-NEXT_RELAY_R14_PROMPT.md](../../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R14_PROMPT.md) 的窗口 3 限定 R5。窗口 4 可并行做只读准备，但**不启动 A/B 双实例恢复**；等 R5 停止、总控复审并重锁最终迁移链。窗口 5 继续等窗口 4 完成及单实例独占信号。`deploy.sh` 接入与真实部署保留发布侧待验，不要求窗口 3 越界修改。
