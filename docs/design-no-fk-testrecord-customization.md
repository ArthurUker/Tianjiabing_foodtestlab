# 设计说明（D-08）：TestRecord 与 SchoolCustomization 之间不建外键

> Phase 10 / D-08。状态：**有意的设计取舍**，不是遗漏；不改动 `schema.prisma`。

## 背景

- `TestRecord`（检测记录）位于**各租户 schema**（`school_<code>`，Schema-per-tenant 方案②）；
- `SchoolCustomization`（按校定制：字段标签/显隐/必填/选项/顺序、自定义字段 `custom_fields`、
  可见模块 `visible_types`、小标题等）与 `School` 一起位于 **public 系统 schema**。
- 记录的动态部分（`sample_info` / `result_data`）以 JSON 存储，其中可能包含由
  `custom_fields` 定义的学校自定义字段值。

直观上会想让 `TestRecord` 引用它写入时所依据的定制版本（外键指向
`SchoolCustomization`），但我们**明确不建这条外键**。

## 为什么不建外键

1. **跨 schema 强耦合**：外键要从租户 schema 指向 public 表。跨 schema 外键会把
   租户数据与系统表硬绑定，租户 schema 的备份/恢复/迁移（`pg_dump` 单 schema、
   `prisma db push ?schema=<租户>`）都会被外键约束卡住，破坏"每个租户 schema 自洽可搬运"的原则。
2. **定制是"演进中的配置"，不是记录的从属实体**：SchoolCustomization 按校持续修订
   （改标签、增删自定义字段、调可见模块）。若记录外键指向某行定制，删除/重建定制行
   就会级联影响历史记录，或被历史记录反向锁死不可清理——两个方向都不可接受。
3. **历史记录必须独立于当前配置可读**：一条 2025 年的记录，即使学校 2026 年删掉了
   某个自定义字段，记录里的该字段值仍应原样保留、可导出。外键+级联语义与这一
   "记录是不可变事实（append-only fact）"的定位冲突。
4. **Prisma 层面的现实约束**：多 schema 下 Prisma 不支持跨 datasource/schema 的关系建模，
   强行建 FK 只能绕过 Prisma 用裸 SQL 维护，反而增加维护成本。

## 没有外键，一致性靠什么保障（替代机制）

| 风险 | 替代保障 |
|------|----------|
| 提交了定制中不存在/非法的自定义字段 | **应用层白名单校验**：前端只收集 `data-custom-field` 标记的注入字段（`collectCustomFieldValues`，且 RK38 规定 `hidden_fields` 中的字段不收集）；字段名必须匹配 `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`（`CUSTOM_FIELD_NAME_RE`）；后端 records API 对 JSON 载荷做消毒与尺寸限制 |
| 定制修订后，旧记录如何被正确解读 | **`data_version` 版本标记**：记录写入时携带数据版本，统计/导出按版本兼容解读；RK21 合格判定对"配置生效前的历史记录缺失该字段"显式跳过（BS-05 回填保护），不误判 |
| 定制被改/删导致历史值不在当前选项内 | 前端渲染时以 disabled「历史值」option 保留原值（CR-03/BS-05），不静默丢弃 |
| 租户与定制归属错位 | `schoolCode` 由 JWT 携带，`tenantMiddleware` 绑定 `req.db` 到对应 schema；定制读取走 `/api/school(s)/.../config`，两者用同一 schoolCode 归一（`schemaNameOf`），无需 DB 级引用即可对齐 |

## 结论

- `TestRecord` ←→ `SchoolCustomization` 的关联是**逻辑上的（schoolCode + data_version）**，
  不是物理外键；
- 该取舍换来：租户 schema 可独立备份迁移、定制可自由演进、历史记录不可变且永远可读；
- 一致性由「应用层白名单校验 + data_version 版本化解读 + 历史值保留策略」共同保障；
- 后续如需审计"记录写入时的定制快照"，方案是**在记录内冗余快照字段**（JSON），
  而不是回头加外键。
