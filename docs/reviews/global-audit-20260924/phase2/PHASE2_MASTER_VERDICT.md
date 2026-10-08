# PHASE 2 · MASTER VERDICT — 第一遍 P1 × Phase 2 A/B/C 独立验证合并结论

- **基线**：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`
- **合并范围**：第一遍全部 **23 个 P1**（ISSUE_INVENTORY.md 摘要表实测 23 个 P1、26 个 P2，共 49 项）+ Phase 2 Batch A（9）/ B（8）/ C（6）独立验证结论
- **文档性质**：归并与证据整理，**不重新审计、不修改应用代码、不重新运行任何破坏性/数据库测试**
- **Severity 原则**：Validity 与 Severity 分离。第二遍建议降级**不自动覆盖**第一遍 severity；两阶段存在分歧的一律 `PENDING`，由 Astra 裁决。本文件不自行创造新 severity 等级。

## Evidence Level 定义

| Level | 含义 |
|---|---|
| **A** | 独立运行时/模块/HTTP/DB 实证（本阶段或第一遍可复跑的实证） |
| **B** | 完整代码路径确定（无运行时实证，路径无分支歧义） |
| **C** | deployment-dependent（触发依赖部署/环境条件） |
| **D** | theoretical only（仅理论推演） |

本批 23 项**无 D 级**；Evidence Level 取"独立验证实际达到的强度"。

---

## 主表（23 项）

| Issue | Title（短） | Orig Sev | Batch | Validity | EV | Reachability | Observed Consequence | Persistent Corruption | Silent | Phase2 Sev 建议 | Severity Status | RC | Dependencies | Arbitration | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AUD-001 | 浏览器缓存/离线队列未按学校账号隔离 | P1 | A | CONFIRMED | A | REALISTIC | 新主体读到旧主体缓存与待上传任务；跨租户重放可致归属错误写入 | NO（本地；跨校写入为条件性） | YES | 保持 P1 | **CONFIRMED_P1** | RC-01 | 与 021/022 同 Storage 层，建议同批 | 否 | 部署为单源（同域名）是本项前提，已证实 |
| AUD-002 | 幂等缓存跨租户/跨主体命中，先于写权限检查 | P1 | A | CONFIRMED | A | REALISTIC | B 校 guest 命中 A 校写响应（含未脱敏 inspector），跳过 editor 守卫 | NO | YES | 保持 P1 | **CONFIRMED_P1** | RC-01 | 与 020 同 recordRoutes 文件面 | 否 | 生产前置认证存在，非匿名可达；需 key+body 精确知识 |
| AUD-003 | 检测字段进入 innerHTML（存储型 XSS 面） | P1 | C | CONFIRMED | A | REALISTIC | 全查看者渲染攻击节点；remark 属性闭合注入成立 | NO（DB 按设计存储；缺陷在输出编码） | YES | 保持 P1 | **CONFIRMED_P1** | RC-05 | 与 025 弱耦合（同属"出口一致性"） | 否（措辞：注入已证/执行未演示） | 页面级与 Caddy 均无 CSP；导出表格已转义 |
| AUD-004 | 恢复暂存 schema 与合法学校撞名被 DROP | P1 | B | CONFIRMED | A | REALISTIC | 整校 DROP CASCADE，双校俱毁（数据不可逆） | YES | YES | 保持 P1 | **CONFIRMED_P1** | RC-03 | **与 005 同批** | 否 | 两处 DROP 均无 ownership 检查 |
| AUD-005 | 在线恢复无同校互斥与写入暂停 | P1 | B | CONFIRMED | B | DIRECT（每次恢复窗口） | STAGING 期已确认写入随切换丢失；并发恢复互删暂存 | YES | YES | 保持 P1 | **CONFIRMED_P1** | RC-03 | **与 004 同批**；写屏障需 Caddy/应用联动 | 是（屏障范围） | 无 mutex/advisory lock/drain；READONLY_MODE 仅人工预设 |
| AUD-006 | 备份计数与 pg_dump 不共享快照 | P1 | B | CONFIRMED | B | REALISTIC | 恢复被 fail-safe 误拒（不产生坏数据） | NO | YES | 降 P2（争议） | **PENDING** | RC-03 | **与 007 同批** | **是** | 分歧：灾备 SLA（P1）vs fail-safe 可重试（P2） |
| AUD-007 | 同秒同范围备份共享文件名 | P1 | B | CONFIRMED | A- | RARE | 单次备份产物损坏/被并发同伴误删 | NO | YES | 降 P2（争议） | **PENDING** | RC-03 | **与 006 同批** | **是** | 无熵/无锁/无原子发布；L1 校验可暴露损坏 |
| AUD-008 | 空库无法从 migration 链部署 | P1 | B | CONFIRMED | A（第一遍独立 PG 实测；本轮不重复） | DIRECT | 空库 P3018/42703；回退 db push 留下 failed 记录→后续部署阻断 | NO | YES | 保持 P1 | **CONFIRMED_P1** | RC-04 | **009 依赖它**；027 依赖其 migration 纪律 | 是（生产 `_prisma_migrations` 实际状态） | 根因：列引入走运行时 DDL，未沉淀进 migration |
| AUD-009 | 启动自愈默认跑 `--accept-data-loss`，租户失败仍汇总成功 | P1 | B | CONFIRMED | B | DIRECT（默认启动必然执行） | 破坏性 schema 变更静默丢列；单校失败 db:sync 退出码仍 0，部署继续 | YES（潜在） | YES | 保持 P1 | **CONFIRMED_P1** | RC-04 | **依赖 008** | 是（自愈去留：P2022 防漂移 vs 静默丢数据） | 默认非 opt-in；仅同步 active 学校 |
| AUD-010 | 停用学校不阻断内部登录与已签发 token | P1 | A | CONFIRMED | B | REALISTIC | 停校后仍可登录/读写；访客入口同样不检查学校状态 | NO | YES | 保持 P1 | **CONFIRMED_P1** | RC-02 | **与 012/014/015/016 同批重构** | 否 | 无触发器/定时任务兜底 |
| AUD-012 | logout/远程会话撤销不绑定 JWT 有效性 | P1 | A | CONFIRMED | B | DIRECT | 已登出/已撤销凭据仍可用（≤30min，refresh 可续期） | NO | YES | 保持 P1 | **CONFIRMED_P1** | RC-02 | 同批 | 否 | Session 表不参与认证/刷新 |
| AUD-014 | 认证 DB 故障先放行两次请求 | P1 | A | CONFIRMED | A | DIRECT | 故障窗口沿用 token 内旧权限（含已禁用账号） | NO | YES | 保持 P1 | **CONFIRMED_P1** | RC-02 | 同批；与 NF-A-01 同批 | 是（阈值策略与离线容错边界） | 阈值无部署覆盖，默认 3 |
| AUD-015 | iat+1 比较漏吊销同秒签发旧 token | P1 | A | CONFIRMED | B | RARE | 单枚 token 漏吊销（access ≤30min；refresh 可续期） | NO | YES | 降 P2（争议） | **PENDING** | RC-02 | 同批（session epoch 一并解决） | **是** | iat+1 为注释在案的有意折中；1 秒窗口 |
| AUD-016 | 改密与吊销非原子，吊销失败仍成功 | P1 | A | CONFIRMED | A | REALISTIC | 改密成功返回但旧凭据未撤销；与 014 叠加放大 | YES（条件性） | YES | 保持 P1 | **CONFIRMED_P1** | RC-02 | 同批 | 否 | 吊销写入在事务外；失败仅告警 |
| AUD-017 | 全局测试报告接口对任意登录身份开放 | P1 | A | CONFIRMED | B | REALISTIC | 任意身份（含 guest）可读写全局测试数据、标记已修复 | NO（模块数据可被污染为条件性） | YES | 降 P2（争议） | **PENDING** | RC-08 | 无 | **是** | 模块注释自称"临时测试工具"，无角色守卫 |
| AUD-020 | 列表缓存与导出静默截断 | P1 | C | CONFIRMED | A | REALISTIC | >1000/2000 条时列表缺历史、报告"声称完整"却缺数 | NO（DB 完整） | YES | 保持 P1 | **CONFIRMED_P1** | RC-07 | 与 002 同文件面（recordRoutes） | 是（修复路径：分页 vs 流式 vs 拒绝） | 1000/2000/10000 三值与 total 忽略已定位 |
| AUD-021 | 离线临时记录编辑丢失 / 幽灵行 | P1 | C | CONFIRMED | A | REALISTIC | 显式保存的编辑静默丢失；删除后幽灵行持久残留 | NO（服务端缺数据） | YES | 保持 P1 | **CONFIRMED_P1** | RC-06 | **与 022 同批** | 否 | POST 负载实测不含编辑值 |
| AUD-022 | 409 重试只换 version 覆盖他人内容 | P1 | C | CONFIRMED | A | REALISTIC | 服务端内容被 stale 覆盖并持久化，双方无提示 | **YES** | YES | 保持 P1 | **CONFIRMED_P1** | RC-06 | **与 021 同批** | 否 | fake HTTP server 端到端实证 |
| AUD-025 | 油脂统计把未知 colorLevel 判合格 | P1 | C | CONFIRMED | B | RARE（需绕过 UI 写入未知值） | 内部/访客统计与 OpenAPI 口径不一致，合格率失真 | NO | YES | 降 P2（争议） | **PENDING** | RC-09 | 与 003 弱耦合 | **是** | 判定分散 4 处且 fail-open；可重算恢复 |
| AUD-027 | 删除用户级联删除其审计历史 | P1 | C | CONFIRMED | B | REALISTIC | 主体维度 AuditLog 不可恢复丢失（SystemLog 保留） | **YES** | YES | 审计保留策略需架构判断 | **P1_REVIEW** | RC-09 | 依赖 008 的 migration 纪律 | 是（保留策略） | 事实成立；单列复盘因策略需架构级决策 |
| AUD-039 | 旧测试用普通 DATABASE_URL 并跨范围破坏清理 | P1 | B | CONFIRMED | B | REALISTIC | 误跑 npm test 可 DROP 生产 schema / 全库降级 admin | YES（条件性：误跑即发生） | YES | 保持 P1 | **CONFIRMED_P1** | RC-10 | 无 | 否 | p0Prov 经 Prisma 自动加载 backend/.env 直连业务库 |
| AUD-044 | 示例 JWT_SECRET 未被启动保护拒绝 | P1 | B | CONFIRMED | B | DEPLOYMENT_DEPENDENT | 公开已知密钥可伪造凭据（冒充真实管理员） | NO（条件性） | YES | 保持 P1（争议） | **PENDING** | RC-10 | 无（一行修复） | **是** | deploy.sh 自动生成不受影响；仅手工部署路径 |
| AUD-047 | 学校删除后 OpenAPI 授权残留可按 code 重附着 | P1 | A | CONFIRMED | B | REALISTIC | 旧对接方在新学校 active 后自动恢复读取权 | NO（授权状态错误） | YES | 保持 P1 | **CONFIRMED_P1** | RC-08 | 若引入学校世代需 schema 变更 → 依赖 008 纪律 | 否 | 删除期由 School.status 检查阻断（临时保护） |

---

## Severity Status 汇总

| Status | 数量 | Issue |
|---|---|---|
| **CONFIRMED_P1** | 16 | 001, 002, 003, 004, 005, 008, 009, 010, 012, 014, 016, 020, 021, 022, 039, 047 |
| **PENDING** | 6 | 006, 007, 015, 017, 025, 044 |
| **P1_REVIEW** | 1 | 027 |
| **DOWNGRADE_CONSENSUS** | 0 | —（第二遍的降级建议尚未经 Astra 确认，故全部计入 PENDING） |
| **UPGRADE_CANDIDATE** | 0 | — |

## Severity Pending 明细（不得自行裁决）

| Issue | 第一遍 | Phase 2 建议 | 分歧要点 |
|---|---|---|---|
| AUD-006 | P1 | P2 | 灾备 SLA（恢复可靠性即安全）vs fail-safe 误拒可重试、不产生坏数据 |
| AUD-007 | P1 | P2 | 备份可靠性要求 vs RARE 触发 + 单次产物损坏可重跑 |
| AUD-015 | P1 | P2 | "吊销机制存在漏洞"语义 vs 1 秒时序窗口 + 注释在案的有意折中 |
| AUD-017 | P1 | P2 | 任意登录身份读写全局数据 vs 不涉租户业务数据 + 代码注释自述临时工具定位 |
| AUD-025 | P1 | P2 | 合规合格率口径失真 vs 需绕过 UI + 可重算恢复 |
| AUD-044 | P1 | P1（保持但标仲裁） | 灾难性尾部风险 + 零成本修复 vs DEPLOYMENT_DEPENDENT（deploy.sh 已自动生成） |

## P1_REVIEW 明细

| Issue | 事实 | 需架构级判断的事项 |
|---|---|---|
| AUD-027 | 删除用户→AuditLog 级联删除成立（user_id NOT NULL + onDelete: Cascade）；SystemLog 独立保留；删除动作以 actor 留痕 | AuditLog 的**保留策略**：属可随主体清理的运营日志，还是须不可变的合规记录（决定软删除/主体快照/去 CASCADE 的 schema 设计） |

---

## 最终统计（准确对账）

```
Original P1 count            = 23   （ISSUE_INVENTORY 摘要表 grep 实测：23 P1 / 26 P2 / 共 49）
Phase 2 independently confirmed = 23  （Batch A 9 + Batch B 8 + Batch C 6，无遗漏、无重复）
False positive               = 0
Partial                      = 0
Not reproducible             = 0
Confirmed P1                 = 16
Severity pending             = 6    （006, 007, 015, 017, 025, 044）
P1 review                    = 1    （027）
Downgrade consensus          = 0    （降级建议待 Astra 确认后才可计入）
```

**第一遍未覆盖的项**：本文件仅覆盖 23 个 P1（用户指定范围）；26 个 P2（含 AUD-011/013/018/019/023/024/026/028…048/049）未纳入本次合并，其 Batch 归属与验证状态不在本文件声称范围内。

**证据来源索引**

| Batch | 报告 | 结构化结果 | 探针 |
|---|---|---|---|
| A | `phase2/BATCH-A-VERIFICATION.md` | `phase2/verification-batch-a.json` | `phase2/probes-batch-a.mjs` |
| B | `phase2/BATCH-B-VERIFICATION.md` | `phase2/verification-batch-b.json` | `phase2/probes-batch-b.mjs` |
| C | `phase2/BATCH-C-VERIFICATION.md` | `phase2/verification-batch-c.json` | `phase2/probes-batch-c.mjs` |

**Phase 2 三批共同结论（供 Astra 参考）**：23 项全部 CONFIRMED，无 false positive、无扩大化（第一遍 impact 措辞经逐项比对未发现夸大；AUD-003 未声称 RCE、AUD-025 用"可能"、AUD-027 限定"随主体"）。分歧集中在 **severity 定级**（6 项 PENDING）与 **审计保留策略**（1 项 P1_REVIEW），不在事实层面。

---

## 附录 · NEW_FINDINGS_CANDIDATES 汇总（Batch A/B/C）

**纪律声明**：以下 8 项均**不进入正式 issue inventory**、**不分配正式 severity**，仅作为候选供 Astra 决定是否立项。`possible parent RC` 为候选与根因矩阵的推测性关联。

| ID | Candidate（候选描述） | Supporting evidence | Possible parent RC | Investigate before remediation? |
|---|---|---|---|---|
| NF-A-01 | `authenticateUser` 末尾 `req.db = createTenantClient(...)` 位于 try/catch **之外**：租户客户端构造失败（如 `DATABASE_URL` 缺失/非法）时，fail-soft 放行的请求以 **500** 逃逸而非 503，且绕过失败计数 | Batch A 探针首次运行实测：`缺少 DATABASE_URL，无法创建租户客户端` 自 `authMiddleware.js:441` 抛出（生产 DB 宕机不触发——Prisma 惰性连接） | RC-02 | **YES**（与 AUD-014 的 fail-soft 边界同批处理，避免两者语义打架） |
| NF-A-02 | 幂等 store 为**进程内 Map**（`idempotencyMiddleware.js:6`）：多实例部署下缓存不共享 → 同一 key 可能在另一实例重复执行写入；"幂等"承诺横向不成立 | `idempotencyMiddleware.js:1-9` 模块自述 + 源码 | RC-01 | **YES**（AUD-002 键改造应与"引入共享存储"一并设计，避免两次语义切换） |
| NF-B-01 | **重新启用停用学校后立即 P2022**：启动自愈/db:sync 只同步 `status:'active'` 学校（`tenantSync.js:174-179`），而 status PATCH（`schoolRoutes.js:404-422`）不触发 provision/db push；长期停用学校在模型演进期间 schema 停留旧版，重新启用即全线 500，须等下一次重启自愈 | Batch B 源码断言 | RC-04 | **YES**（与 AUD-008/009 同批；属"演进纪律"修复范围的自然延伸） |
| NF-B-02 | 恢复流程把**解密后明文 SQL** 写入 `/tmp/restore_*.sql`（mode 0600，finally unlink）：服务器 /tmp 短暂存在全量业务数据明文，崩溃可能残留 | `restoreService.js:127-133` | RC-03 | **NO**（可在 AUD-004/005 恢复引擎重构时顺带改为私有目录/流式管道） |
| NF-B-03 | `deploy.sh` 将 `migrate deploy` 的 stderr 重定向丢弃（`2>/dev/null`）：部署日志无法呈现 migration 失败根因 | `deploy/deploy.sh:512` | RC-04 | **YES**（AUD-008 修复建议已含此项，低成本；应与补丁 migration 同批） |
| NF-C-01 | **详情弹窗是独立于列表的第二批注入点**：`Pathogen.js:1181`（title/sampleId/testDate）与 `GenericTest.js:350-352`（整改日志 user/action/content）；即使修好列表渲染，详情路径仍暴露 | Batch C SINK_SURVEY + 源码 | RC-05 | **YES**（AUD-003 的修复范围**必须**显式包含详情与导出预览） |
| NF-C-02 | 仓库存在 **7+ 份分叉的 `escapeHtml` 实现**（backupManager/AuditLog/adminSchools/ui/sidebar/diskView/shared…），语义未统一——AUD-003 反复出现的结构性原因 | 全仓 grep | RC-05 | **YES**（AUD-003 实施前先收敛为单实现，否则修复会加剧分叉） |
| NF-C-03 | 导出 `?limit=10000` 无任何超限告警；后端 `MAX_RECORDS_LIMIT` 若变化，前端不会自动受益（无 total 校验），截断点静默漂移 | `ExportService.js:353` + Batch C 2501 条实测 | RC-07 | **NO**（AUD-020 的契约修复范围可覆盖） |

**汇总口径**：Batch A 3 项中 2 项（A/B 已并入正式判定的证据链，但不改变 23 项 P1 的范围）→ 本表 8 项候选；其中 **6 项标 YES（建议在对应 remediation 批次内先行调查）**、2 项标 NO（可在相关重构中顺带处理）。
