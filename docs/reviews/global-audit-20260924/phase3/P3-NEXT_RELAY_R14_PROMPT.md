# R14 下一棒：窗口 3 限定 R5

```text
执行 P3-LIFECYCLE-AB-R5（窗口 3 限定返工）。先读 docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md、docs/AI_review/Codex-GPT6/P3-LIFECYCLE-AB-R14_REVIEW.md、evidence/P3-LIFECYCLE-AB-R4/RESULT.md、ERRATA_R3.md、TEST_RESULTS.json，再读 004 脚本、M2 migration、006 门禁与已有 R4 判别日志。R4 证据/HASHES 一字不改；新证据只写 evidence/P3-LIFECYCLE-AB-R5/。开工固定 HEAD/index、16 文件逐文件 sha/bytes、产品 migrationChainDigest、schema/client hash、冻结 29 和窗口 4/5 是否仍 HOLD。勿与其他窗口同时编辑 migration/client 或跑全量。

只修两项。

R14-1（004 陈旧映射）：P-2 每行必须有可验证的绑定前事实 pre，不能只靠可选 valid_until 或文件 SHA；定义 pre 至少覆盖该 (schema,audit_id) 行的 user_id、principal_id、完整 actor_snapshot 的规范化摘要及绑定前事实（仅核 subject_user_id 不足以发现 username-only 快照变化），并保留 evidence/approved_by/reviewed_at。预校验已绑定行时，读取其 AuditPrincipal.scope_key/subject_user_id：与映射一致才能作为幂等重跑，不一致整体非零拒绝；不能直接跳过。验证未知/重复/跑外/稳定值冲突的既有保护不降级。补真实 PG 反例：缺 pre、事实变化、已绑定同主体重跑、已绑定异主体拒绝、两校同 audit_id 各自绑定；拒绝前后审计行和主体计数/hash 精确相同。若 004 允许并发写入，则在绑定 UPDATE 加 pre 条件与 rowCount 校验，禁止“预校验后变化”误绑；如需专用排他执行前提，必须在 CLI 中可执行地拒绝不满足前提，不能只写文档。不要自动猜 username，也不要改历史已绑定主体以凑绿。

R14-2（M2 系统事件空快照）：M2 P-4 与 006/G3 和 M2 4.5 使用同一语义空谓词（SQL NULL、JSONB null、空对象）。在未先跑 004 的干净 staging 内，分别放入 principal_id NULL、user_id NULL、上述三类快照的历史系统行，真实单次 applyTenantChain/align 必须一次推进到终态，系统主体绑定正确、G2/G3/G7/G8 和 db:sync --check 通过；加入带真实人类快照但无稳定 id 的负例，必须 M2_UNBOUND_PRINCIPAL_ROWS、旧 schema 保留、无猜测。遵守 migration 是否已发布的事实：先核对本会话与可见证据中的发布/共享应用记录，不连接生产库。若无法排除旧 M2 checksum 已用于共享/生产环境，报告版本兼容阻塞并给出可执行的前置修复方案；不要静默改历史，也不要声称在失败的 M2 后面追加 migration 就能修复。只有确认仍属未发布本地链时，才修现有 M2；旧/新 checksum、逐文件链锁、产品 digest、隔离实例台账按时点分列，不能混用 R4 旧证据。

复跑 R4 受影响的 R13-2/R13-3、B 23/23、单次 staging align 定点、006、db:sync --check；A 33 与受影响 Jest/OpenAPI 如源码未改可做只读 hash 归因，若改到共享面则跑对应定点。新增反例逐入口 rc/0 skip；冻结 29、git diff --check、输入 drift、HASHES_FINAL 双复验、自有实例 down 四条件。报告 R13-1 管理端守门与 R13-4 发布脚本未动的 hash；不得将发布沙盒写成 deploy.sh 接线或真实部署。明文停止并释放 migration/client 面后回交总控复审。

窗口 4 双实例真实恢复继续 HOLD，窗口 5 全量回归最后执行；不 reset/clean/stash/checkout，不 stage/commit/push，不真实部署。
```
