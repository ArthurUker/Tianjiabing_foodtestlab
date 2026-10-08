# P3-LIFECYCLE-AB-R3 限定复审（R13，2026-09-27）

## 裁决

**A/B REWORK；窗口 4 双实例真实恢复继续 HOLD。** A 33/33、B 23/23、受影响 Jest 111/111、OpenAPI HTTP 12/12、终态 `db:sync --check` 与 006 门禁成功的局部证据可保留；它们尚未证明全部读路径和映射证据边界。窗口 3 的明文停止已满足资源接力，但不能代替总控质量裁决。窗口 5 全量回归仍 HOLD。

## 独立核验

- 当前迁移链 16 文件，产品 `migrationChainDigest()`=`0c5df7cccbfbc095eceed4e2e1d9880deedfabcf1df18338b8a02220b7b7ce78`；旧 14 文件的逐文件锁由交付包取证。锁聚合值与产品值分列口径已遵守。
- `verify.mjs hash --verify HASHES_FINAL.json` 实测 **43/43 ALL_MATCH**；冻结 29 独立只读核验 **29/29 ALL_MATCH**。交付包没有 `hash-final.mjs`，实际使用 `verify.mjs`；`HASHES_FINAL.json.phase` 仍写 `design-only`，属于元数据错误。`TEST_RESULTS.json.chain.digestNow_16files` 留 `ee80d133…` 中途值，与终态实测 `0c5df7cc…` 不符；`RESULT`/A、B 矩阵使用终态值。旧证据应保留，后续包出勘误。
- `git diff --check` 当前**非零**：`backend/prisma/schema.prisma:87` 有行尾空格。须在返工包修复并留 rc。

## 必修缺口

1. **管理员预览/字典绕过 grant 身份校验**：`backend/routes/adminOpenApiRoutes.js:404-460` 的 `GET /clients/:id/preview` 与 `:461+` 的 `GET /clients/:id/dict` 仍只查 grant `active` 和学校 code/status，未调用 `classifyGrantIdentity`/`quarantineGrant`，`findUnique` 也未取学校 `id/generation`。这两条路径会对缺身份、错学校实体或过期世代的 grant 继续给出预览或字典；与 R12 明确的 A4 交叉面要求冲突。须共用同一身份判定，并以真实 HTTP 反例验证预览不会取样数据、字典不会下发。
2. **004 映射证据可错绑主体**：`backend/scripts/004_backfill_audit_principals.mjs:65-78,110-119` 将映射仅按 `audit_id` 建 Map，并在稳定的 `actor_snapshot.subject_user_id` 之前应用。一个仅凭文件 SHA 完整性的映射可以覆盖已有稳定快照；`--all-tenants` 时不同 schema 相同审计 ID 也会共用同一映射。须以 `(schema,audit_id)` 定位，稳定 `user_id`/快照与映射冲突时拒绝，逐行保留可审证据来源并防重复/陈旧行。SHA 校验只证明文件未变，不能单独证明身份归属。
3. **006 语义空值不对称**：`backend/scripts/006_audit_principal_gate.mjs:40-44` 的 G3③ 把 JSONB `null`/`{}` 当空，而 G3④ 只用 SQL `IS NULL`。人类 principal + `user_id NULL` + `actor_snapshot='null'::jsonb` 会通过 G3④。须统一空值口径并加负例。
4. **B 发布门禁仍是流程约定**：`deploy.sh` 实际在迁移前生成 client；R3 的 B-P6 证明本地能切换 A/B client，未提供可执行发布入口在门禁失败时拒绝生成/激活 B client。故 B 的数据库/客户端局部演练可认可，**发布安全门禁不能称已接线**。返工包应给出真正可执行且沙盒验证的两段入口，或明确将 B 发布标记为 blocker；不得真实部署。该项与窗口 4 的隔离恢复联测可分开验收，但阻止最终部署验收。

## 接力

先给窗口 3 [P3-NEXT_RELAY_R13_PROMPT.md](../../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R13_PROMPT.md) 做限定返工；窗口 4 可只读准备，但真实 A/B 双实例恢复待本返工停止和总控复核。B 矩阵的 `B-P7` 是直接调用 `applyTenantChain` 的 staging 模拟，尚非 `restoreService` 全链路；该缺口本来就由窗口 4 验证。
