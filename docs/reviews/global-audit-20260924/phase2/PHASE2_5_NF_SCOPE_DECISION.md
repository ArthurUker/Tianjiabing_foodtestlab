# PHASE 2.5 — NF 候选的修复边界判定（不新增 issue）

- **基线**：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`
- **性质**：仅对 4 组 NF 候选做"是否改变后续架构修复边界"的判定；**未重新审计、未重跑任何测试、未修改应用代码**
- **三选一口径**：`ALTERS_REMEDIATION_SCOPE` / `DOES_NOT_ALTER_REMEDIATION_SCOPE` / `NEEDS_SEPARATE_FINDING`
- **目标**：输出边界判定，不增加 issue 数量

## 判定速览

| NF | 判定 | 受影响的重构 | 边界变化（一句话） |
|---|---|---|---|
| NF-A-02（进程内幂等 store） | **ALTERS_REMEDIATION_SCOPE** | AUD-002（RC-01） | 从"改键 + 调整中间件顺序"扩展为"+ **单实例假设的显式声明与迁移触发条件**"；建议顺带登记散落的进程级状态 |
| NF-B-01（停用学校重新启用后 P2022） | **ALTERS_REMEDIATION_SCOPE** | AUD-008/009（RC-04） | RC-04 目标架构需新增"**学校启用/停用时的 schema 对齐路径**"，并把该场景纳入 008/009 验收 |
| NF-B-02（恢复期 /tmp 明文全量 SQL） | **DOES_NOT_ALTER_REMEDIATION_SCOPE** | AUD-004/005（RC-03） | 状态机/互斥/ownership 边界不变；仅追加实现规范（私有目录 + 流式 + 及时清理） |
| NF-C-01 + NF-C-02（第二批 sink + 8 份 escape helper） | **ALTERS_REMEDIATION_SCOPE** | AUD-003（RC-05） | 从"逐 sink 转义"升级为"**统一 safe-rendering abstraction + 全 sink 普查**"，8 份 helper 收敛为 003 的前置 |

```
ALTERS_REMEDIATION_SCOPE:          3 组（NF-A-02 / NF-B-01 / NF-C-01+C-02）
DOES_NOT_ALTER_REMEDIATION_SCOPE:  1 组（NF-B-02）
NEEDS_SEPARATE_FINDING:            0
```

---

## NF-A-02 · 进程内 idempotency store → **ALTERS_REMEDIATION_SCOPE**

**边界变化的精确内容**

- AUD-002 的修复交付物原边界："键绑定 tenant/subject/method/path + 中间件移到认证授权之后（或缓存脱敏响应）"。
- 新边界：**再加一项"正确性所依赖的部署拓扑必须显式化"**——幂等仅承诺单进程内有效；该假设必须以代码注释/启动检查/部署文档三种形式之一固化，并给出"何时必须改为持久化"的触发条件。
- 判定为 ALTERS 而非 DOES_NOT_ALTER 的理由：修复的**正确性前提**从"进程内语义"变成"部署拓扑语义"；若不做声明，未来横向扩展时同一 key 会在不同实例重复执行写操作，而 AUD-002 的修复验收（跨主体不命中）**无法暴露**该缺口。

**支撑证据（复用已收集证据，未重跑）**

- `backend/middleware/idempotencyMiddleware.js:1-2` 自述"内存存储仅适用于单实例或低并发环境，生产建议使用 Redis"；`:6` 模块级 `const store = new Map()`。
- 部署拓扑为明确单实例：`deploy/README.md:20`（systemd，已确定不用 PM2）、`:21`（PostgreSQL 单实例）。
- **关键前置发现**：项目已有同模式的既有处理——`deploy/README.md:106-112`"⚠️ 已知限制（切换多实例部署前必读）：安全事件告警扫描器假设单实例运行……当前无影响：本部署方案为 systemd 单进程托管"。
- 同一"进程级状态"家族还包括：`authMiddleware.js:220-221`（认证回查失败计数为进程级，Batch A 已确认）、`authMiddleware.js:483`（guestVisibleTypesCache 进程内）、`authMiddleware.js:205`（auth 状态缓存注入点）、`securityAlerts` 扫描状态。

**对 remediation 的约束**

1. AUD-002 的验收需增加一条："多实例部署时幂等行为如何变化"的说明存在于部署文档（可复用 README 既有章节，新增条目，不必新开章节）。
2. 建议把散落的进程级状态**集中登记为一份"单实例假设清单"**（放 `deploy/README.md` 已知限制章节），把"何时必须处理"写成切换多实例前的 checklist；这属于跨 issue 的**文档交付物**，不新增 issue。
3. 若 6 个月内有横向扩展计划 → 本项升级为"持久化方案决策"（Redis/DB），届时需与 AUD-001/021/022 的客户端队列改造协调（同一波次，避免两次语义切换）。

---

## NF-B-01 · 停用学校重新启用后 P2022 → **ALTERS_REMEDIATION_SCOPE**

**边界变化的精确内容**

- RC-04 的目标架构原边界："schema 变更唯一入口 = migration；启动自愈降级为检查 + 告警"。
- 新边界：**必须同时定义"停用学校在演进期间与重新启用时"的 schema 对齐路径**，否则"自愈降级"会制造一个新缺口：
  - 现状 `tenantSync.js:174-179` 只同步 `status:'active'` 学校；
  - `schoolRoutes.js:404-422` 的 status PATCH 不触发 provision/对齐；
  - 自愈降级为"只检查"后，若"检查"仍只覆盖 active 学校，则停用学校永远不被检查、启用瞬间即 P2022。
- 判定为 ALTERS 的理由：这不是实现细节，而是**演进纪律目标架构的一个缺失分支**（学校生命周期的 schema 状态机）；把它留给 008/009 之外的时机处理，会导致 009 的修复被判定"引入回归"。

**支撑证据（复用 Phase 2 Batch B 结论）**

- `backend/lib/tenantSync.js:174-179`（`where: { status: 'active' }`）。
- `backend/routes/schoolRoutes.js:404-422`（仅 `prisma.school.update({ data: { status } })`，无 provision/align 调用）。
- 可复用现成能力：`tenantProvisioner.alignTenantSchema`（`tenantProvisioner.js:244-272`）已存在，只是未被"启用"路径调用。

**对 remediation 的约束**

1. AUD-008/009 的验收必须显式包含场景：**"停用学校 → schema.prisma 演进（新增列）→ 重新启用 → 业务接口可用"**；该校验缺失即视为 009 修复不完整。
2. 目标架构中的"检查"阶段必须覆盖 disabled 学校（否则该分支不可观测）；"对齐"应作为**显式动作**出现在启用流程（或启动自愈的可选深度检查，但不得使用破坏性参数）。
3. **不单独立项**：与 RC-04 强耦合，纳入 008/009 批次即可。若 Astra 需要独立可追踪条目，可拆为 P2，但其修复时点不得脱离 RC-04（否则会与 008/009 的验收互相干扰）。

---

## NF-B-02 · 恢复期 /tmp 明文全量 SQL → **DOES_NOT_ALTER_REMEDIATION_SCOPE**

**判定理由**

- RC-03 的架构边界由四件事决定：**任务归属台账、暂存命名空间独占、ownership 校验、并发互斥/写屏障**（AUD-004 + AUD-005）。临时文件的**存放位置与生命周期**不改变这套状态机设计。
- 该候选的实际处置方式是实现规范：把 `os.tmpdir()` 下的明文 SQL 改为"备份/恢复专属私有目录（权限收紧）+ 流式管道（不经磁盘明文）或加密临时文件 + 进程崩溃后的残留清理"。
- 这些改动**在同一重构中被自然包含**（恢复引擎本来就要改暂存与清理逻辑），不产生额外的架构决策、schema 变更或部署依赖。

**支撑证据（复用 Phase 2 Batch B 结论）**

- `backend/lib/restoreService.js:127-133`：`path.join(os.tmpdir(), 'restore_${Date.now()}_...sql')` + `mode 0o600` + `finally unlink`（异常崩溃时可能残留）。
- 同文件已有私有目录先例可参考：备份产物走 `backupRootDir()` 且目录 `chmod 0700`（`backupService.js:330-331`）。

**对 remediation 的约束（实现规范追加项，非架构）**

1. RC-03 重构的实现规范增加一条：临时明文不得落共享 `/tmp`；优先流式（psql 直接从管道读），必须落盘时放备份私有目录并及时清理；崩溃残留纳入"恢复任务台账"的清理阶段（与 ownership 台账天然协同）。
2. 验收可增加："注入恢复中断后，无明文残留可被同机其他用户读取"。

---

## NF-C-01 + NF-C-02 · 第二批注入 sink + 8 份 escape helper → **ALTERS_REMEDIATION_SCOPE**

**边界变化的精确内容**

- AUD-003 的修复原边界（按第一遍描述）："文本使用 textContent；属性用 DOM 属性赋值；统一复核各模块表格、详情、导出预览的输出上下文"——但未定义**范围如何封闭**与**实现是否统一**。
- 新边界（合并两项后）：
  1. **前置 = sink 普查**：在动手前枚举全部输出通道（`innerHTML`/`insertAdjacentHTML`/`document.write`/属性拼接 `title="${...}"`/导出预览/打印），把"修几个 sink"变成"**封闭全量 sink 清单**"；
  2. **前置 = 实现收敛**：8 份分叉的 `escapeHtml` 收敛为单一共享实现，再以"唯一数据 → DOM 通道"约束各模块。
- 判定为 ALTERS 的理由：这是从"点修"到"建立抽象"的**方案级变化**；同时 NF-C-02 是 NF-C-01 反复出现的结构性原因（8 份实现意味着每次新增模块都可能再造一个 sink）。

**支撑证据（复用 Phase 2 Batch C 结论 + 本轮只读复核）**

- 独立注入点已实证：`Pathogen.js:1181`、`GenericTest.js:350-352`（详情/整改日志）与列表（`GenericTest.js:1332/1345-1347`）分属不同 sink；探针已确认 `img[onerror]` 与 `div[onmouseover]`（属性闭合）。
- `escapeHtml` 实测 **8 份实现**（本轮只读复核）：`utils/schoolCustomization/shared.js`、`modules/backupManager.js`、`modules/AuditLog.js`、`modules/adminSchools/ui.js`、`modules/adminSchools/sidebar.js`、`modules/adminSchools/views/diskView.js`、`modules/adminSchools/views/backupView.js`、`modules/adminSchools/views/openApiView.js`。
- 已有部分缓解需保留说明：导出表格单元格已使用 `_escapeHtml`（`ExportService.js:688`），修复时不得回退该处。

**对 remediation 的约束**

1. AUD-003 实施前先产出 **sink 普查清单**（含属性上下文与导出/打印路径），验收按清单逐项关闭；不得以"列表已修"结项。
2. 8 份 helper 的收敛是 003 的**前置**，不可与各模块分头修补并行（否则分叉扩大，且转义语义不一会引入新的显示错误）。
3. **不单独立项**：C-01/C-02 分别是 003 的范围与前置，不构成独立缺陷。

---

## 其余 NF 的分派确认（按既定安排，不改变架构边界）

| NF | 分派 | 边界确认 |
|---|---|---|
| NF-A-01（`req.db` 注入在 try 外 → 500） | 随 auth/error-handling 重构（RC-02 批次，与 AUD-014 同批） | 不改变 RC-02 边界：属认证降级路径的错误处理细节，随 fail-soft 边界一起定义即可 |
| NF-B-03（deploy.sh 吞 migrate stderr） | 并入 AUD-008 部署修复 | 不改变 RC-04 边界：属部署可诊断性，已包含在 008 的修复清单内 |
| NF-C-03（导出 limit 无超限告警） | 并入 AUD-020 完整性契约 | 不改变 RC-07 边界：三选一契约（分页/流式/显式拒绝）本身即覆盖超限语义 |

---
 
## Phase 2.5 结论

- 结果**改变架构修复边界的 3 组**：`NF-A-02`（→ 002 增加部署假设声明）、`NF-B-01`（→ RC-04 增加学校生命周期对齐分支）、`NF-C-01/C-02`（→ 003 升级为统一渲染抽象 + 全 sink 普查）。
- **不改变边界 1 组**：`NF-B-02`（→ 仅实现规范追加）。
- **需独立立项 0 项**：本阶段不新增任何正式 issue；若 Astra 要求可追踪条目，唯一候选是 `NF-B-01`（建议 P2，但修复必须留在 RC-04 批次内）。
- 下一步按用户既定流程进入 **Astra Final Arbitration**（severity 6 项 PENDING + AUD-027 P1_REVIEW + 本文件的 3 项边界扩展）；Phase 3 的波次规划沿用 `REMEDIATION_DEPENDENCY_GRAPH.md`，其中 W2 需按本文件纳入"学校启用对齐路径"与"单实例假设清单"两项交付物。
