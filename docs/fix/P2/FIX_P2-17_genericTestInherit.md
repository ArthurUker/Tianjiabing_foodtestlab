# FIX-P2-17：各检测模块未继承 GenericTest，存在大量重复代码

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-17` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/modules/Tableware.js`、`js/modules/Pathogen.js`、`js/modules/GenericTest.js`、`js/modules/BaseTestModule.js`、`js/main.js` |
| **预估工时** | 4h+（分三阶段，含试点与回归） |
| **关联问题** | P2-10（全局暴露，正交） |
| **状态** | 🔲 方案已完成，暂缓实施（P1优先） |

---

## 1. 问题描述

`RG_03c` 记录：`GenericTest.js` 作为基类但各检测模块未通过继承复用，存在大量重复代码。原"修复建议"仅一句话：*将 `Tableware.js`、`Pathogen.js` 等重构为继承 `GenericTestModule` 的子类*。

经代码实证，情况比原描述更复杂，**存在两套并行基类**：

| 基类 | 定义位置 | 被使用情况 |
|------|----------|------------|
| `GenericTestModule` | `js/modules/GenericTest.js`（被 `main.js:3` import） | ✅ **活跃**：`main.js:242-244` 已用于 `pesticide` / `oil` / `leanMeat` 三个模块 |
| `BaseTestModule` | `js/modules/BaseTestModule.js` | ❌ **全仓无人 import**（仅 `docs/dev/` 文档引用），疑似历史半成品/废弃实现 |
| `GenericTestModule extends BaseTestModule` | `BaseTestModule.js:655` | ❌ 同上，未使用 |
| `PathogenTestModule extends BaseTestModule` | `BaseTestModule.js:667` | ❌ 同上，未使用 |
| `TablewearTestModule extends BaseTestModule` | `BaseTestModule.js:673` | ❌ 同上，未使用 |

**当前真实结构**：
- `pesticide` / `oil` / `leanMeat` 已正确继承 `GenericTest.js` 的 `GenericTestModule`（规范基类）。
- `Tableware.js`、`Pathogen.js` 为**独立实现**，未继承任何基类，其内部列表渲染 / CRUD / 事件逻辑与 `GenericTestModule` 高度重复。
- `BaseTestModule.js` 本身即是 P2-17 要消除的"重复代码"（两套 `GenericTestModule` 命名冲突、三套 `BaseTestModule` 子类未被使用）。

---

## 2. 根因分析

项目早期曾尝试以 `BaseTestModule.js` 统一基类并预置 `PathogenTestModule` / `TablewearTestModule` 子类，但该方案未被接线（活跃代码仍走 `GenericTest.js` + 独立 `Tableware.js` / `Pathogen.js`）。两套实现并存导致：
- 命名冲突（`GenericTestModule` 在两文件各定义一次，语义不同）；
- `Tableware` / `Pathogen` 重复实现基类已具备的列表/CRUD/事件能力；
- 后续维护者无所适从（不知应以哪套为准）。

---

## 3. 修复方案

> ⚠️ **报备（PROJECT_CONVENTIONS 规则二 + FIX_PLAN 超范围确认）**：本项为大型架构重构，单文件改动可能 >30%。实施前须获人工确认，并先就"规范基类选型"达成一致。方案采**分阶段、试点先行、禁止全文重写**策略。

### 阶段 0 — 决策并统一规范基类（前置，低风险）
- **选型建议**：以 `GenericTest.js` 的 `GenericTestModule` 为**唯一规范基类**（已被 3 个生产模块验证）。
- 将 `BaseTestModule.js` 整体标记为待废弃；其内 `PathogenTestModule` / `TablewearTestModule` 的可用片段（若有）并入 `GenericTestModule`，随后删除 `BaseTestModule.js`（消除重复代码本身，属本项附加收益）。
- 此阶段不触达业务模块，仅收敛基类。

### 阶段 1 — 试点：重构 `Pathogen.js` 继承 `GenericTestModule`（中风险）
- 将 `Pathogen.js` 改为 `class PathogenTestModule extends GenericTestModule`，构造时传入 `moduleName: 'pathogen'` 等。
- 抽离与基类重合的**列表渲染 / 记录加载 / CRUD / 事件绑定**逻辑到基类调用；**保留 Pathogen 专有逻辑**：Word 文档解析（`parseDetectionReport`）、风险计算（`pathogenRisk.js`）、Mammoth.js 动态加载、`module:pathogen` 访客守卫（P1-18）。
- 选 Pathogen 作试点理由：它最独立、与餐具/农残业务耦合最少，回退成本最低。

### 阶段 2 — 推广：重构 `Tableware.js` 继承 `GenericTestModule`（中风险）
- 同理将 `Tableware.js` 改为继承 `GenericTestModule`，抽离重复渲染/CRUD；保留餐具专有判定（洁净度分级、洗/冲/消三段）。
- 完成后删除 `BaseTestModule.js`，P2-17 闭环。

### 方案 B（备选，保守）
仅执行阶段 0（删除未使用的 `BaseTestModule.js` 死代码、消除命名冲突），`Tableware`/`Pathogen` 暂不改写。风险最低，但"重复代码"仅部分消除。

---

## 4. 验收标准

- [ ] `Tableware.js` / `Pathogen.js` 不再包含与 `GenericTestModule` 重复的列表渲染 / CRUD / 事件逻辑（通过 `grep` 对比）
- [ ] 全仓仅存在一个 `GenericTestModule` 定义（`GenericTest.js`），`BaseTestModule.js` 已删除或合并
- [ ] `pesticide` / `oil` / `leanMeat` / `tableware` / `pathogen` 五个模块功能与重构前一致（浏览器 Console 验证渲染、新增、编辑、删除、详情）
- [ ] 访客的 `module:pathogen` 守卫（P1-18）仍生效

## 5. 回归测试要点

- [ ] 五个检测模块各自新增/编辑/删除一条记录正常，数据正确落库与同步
- [ ] 病原体 Word 导入解析与风险分级结果不变
- [ ] 餐具洁净度分级展示不变
- [ ] 快速访问 / 访客模式下病原体模块不可见（P1-18）

## 6. 备注

- ⚠️ 每阶段须保留行为一致，**禁止全文重写**；基类方法签名变更须同步更新全部子类调用方。
- `BaseTestModule.js` 虽未被业务 import，删除前仍须 `grep` 确认 `docs/dev/` 之外的任何引用（含测试/脚本）均已清理，避免死链。
- 本项与 P2-10 正交：P2-17 改类继承结构，P2-10 改全局暴露，可独立推进（建议 P2-10 阶段 B 与 P2-17 阶段 1 错开提交，降低回归排查难度）。

---

## 7. Tableware 继承化设计分析（P2-17 试点评估）

> 本节基于通读 `js/modules/GenericTest.js`（1170 行）与 `js/modules/Tableware.js`（1290 行），并核对 `js/main.js:244-248` 实例化写法，评估将 `Tableware.js` 重构为 `extends GenericTestModule` 子类的可行性与成本。

### 7.1 基类 API 盘点（GenericTestModule）

**构造函数配置项**：`constructor(config)` 接收 `{ moduleName, formId, tableId }`（`GenericTest.js:10-26`）。内部自动创建 `new StorageService(moduleName)`，并初始化 `currentPage=1`、`recordsPerPage=10`、`sortOrder='desc'`、`selectedCanteenFilter='all'`、`selectedMeatTypes=[]`。
- 现有实例化（main.js:246-248）：`new GenericTestModule({ moduleName:'pesticide'|'oil'|'leanMeat', formId:'…TestForm', tableId:'…Records' })`。
- Tableware 若改造：`new TablewareModule({ moduleName:'tableware', formId:'tablewareTestForm', tableId:'tablewareRecords' })`（替换 main.js:244 的 `initTableware()`）。

**可复用方法**：

| 方法 | 行号 | 复用点 |
|------|------|--------|
| `init()` | L28-87 | 表单提交绑定、表格点击委托（删/改/详情 + 权限前置）、`addTestPoint` 按钮、`setupPaginationListeners`、`render`、`storage.on('sync')` |
| `setupPaginationListeners()` | L89-184 | 分页/上页/下页/食堂筛选/每页条数/排序/跳页 全套监听 |
| `getFilteredRecords()` | L186-216 | 快速访问模式 localStorage 读取 + 食堂过滤 + leanMeat 肉品种过滤 |
| `getRecordCanteen()` / `getRecordDate()` | L218-236 | canteen 归一化、日期解析（排序用） |
| `updatePaginationUI()` | L238-254 | 分页信息文本 + 页码按钮 HTML |
| `handleDeleteRecord()` | L256-281 | 权限校验 + 确认 + 删除 + 重渲染 + `dataChanged` |
| `handleEditRecord()` | L283-294 | 查记录 → 找不到报错 → `showEditModal` |
| `showEditModal()` | L296-487 | 整改 tab + 日志渲染 + 复检 tab + tab 切换 + 保存逻辑 |
| `showDetailModal()` | L489-575 | 详情弹窗（按 moduleName 分支渲染字段） |
| `updateFormStructure()` | L711-864 | 表单重组 + 备注字段 + 油品字段 + 表头/分页容器生成 |
| `addRemarkField()` / `addTestPoint()` | L866-951 | 备注字段、克隆点位段 |
| `handleSubmit()` | L953-1084 | 基础校验 + 按 moduleName 抽取点位 + 批量保存 |
| `render()` | L1086-1169 | 列表渲染（结果三元着色、操作按钮） |

**现有隐式扩展点（基类用 `if(moduleName===…)` 分支实现）**：
- `handleSubmit` L996-1046（点位字段抽取分支）
- `render` L1124-1140（列表额外列分支）
- `showDetailModal` L505-542（详情字段分支）
- `updateFormStructure` L721-749、L785-807（标题文案、leanMeat 肉品种筛选、oil 字段）
- `addRemarkField` L873-882（备注标签）
- `init` L43-45（oil 专属初始化）、`addTestPoint` L934-948（oil 字段）
- `getFilteredRecords` L211-213（leanMeat 肉品种）

> 这些分支是"硬编码钩子"，未抽成独立方法。要让 Tableware 干净接入，**建议**把上述分支改为可覆写的独立钩子方法，并以"与现状逐字一致的默认实现"保证三模块零回归。

### 7.2 Tableware.js 功能分类（A / B / C）

| 功能点 | 归类 | 说明 |
|--------|------|------|
| `handleEditRecord()` L111-122 | **A** | 与基类 `handleEditRecord` L283-294 逐行一致，可直接删除复用基类 |
| `handleDeleteRecord()` L610-644 | **A**（需钩子） | 权限+确认+删除+渲染+`dataChanged` 骨架与基类一致，仅多 `auditLogService` 调用；加 `onAfterDelete` 钩子后可整体删除复用 |
| `updatePagination()` L998-1014 | **A**（需对齐 ID） | 与基类 `updatePaginationUI` L238-254 分页数学+按钮 HTML 一致，仅元素 ID 未命名空间化；对齐 HTML ID 后可删 |
| `setupPaginationListeners()` L902-995 | **A**（需对齐 ID） | 分页/筛选/排序监听逻辑与基类一致，仅 ID 不同；对齐后可复用基类 |
| `initTableware()` L13-107 | **B** | 与基类 `init()` 高度同构，但额外有 `atpPointsContainer` 删除委托 + `dataChanged` 监听；可改为 `super.init()` + 子类补充 |
| `showEditModal()` 整改 tab/日志/tab切换/btnSaveLog L124-302 | **A**（需钩子） | 与基类整改部分 L296-450 几乎完全一致，加 `onAfterCorrectiveSave` 审计钩子即可复用 |
| `showEditModal()` 复检 tab（atpPoints+bindRluCalc+finalStatus）L304-384 | **B/C** | 复检数据结构为 `points[]`，与基类 `description` 模型不同；需覆写 `renderRecheckHistory`/`saveRecheck` 钩子 |
| `determineResult`/`getResultIcon`/`getResultClass`/`updateResultFieldStyle` L413-438,1018-1024 | **C** | 餐具 RLU/洗涤剂阈值与样式，基类无，保留子类 |
| `updateFormStructure()` 自建表单 DOM L440-608 | **C/B** | 基类按既有表单"重组"，Tableware 自建顶部字段/整改区/表头；结构不同，需覆写 `updateFormStructure` 或加 `buildCustomForm` 钩子 |
| `handleFormSubmit()`（atpPoints 数组）L646-735 | **B/C** | 基类每点位段存一条记录；Tableware 存"一条含 `atpPoints` 数组"；需覆写 `handleSubmit` 或 `extractPointData` 钩子 |
| `renderTable()`（rowspan 多行/atpPoints/finalStatus/thead）L738-899 | **C/B** | **1 记录 = N 行**模型与基类 **1 记录 = 1 行**根本不同；需覆写 `render()` 或 `renderRecordRows` 钩子 |
| `showTablewareDetail()` L1178-1286 | **C/B** | 详情为 atpPoints + 复检 points，与基类 `showDetailModal` 模型不同；覆写 `showDetailModal` |
| `getLocationOptionsByType`/`bindPointEvents`/`getPointTemplate`/`addAtpPoint`/`getSimplePointTemplate`/`bindRluCalc` L387-395,398-409,1026-1032,1034-1051,1054-1134,1136-1175 | **C** | 餐具点位管理特有；基类 `addTestPoint` 用 clone 方案不同，保留子类 |
| `window.initTableware`/`window.showTablewareDetail`/`window.renderTablewareData` L47-49,1178,1289 | **C（待清理）** | 改为类后由实例方法取代，属 P2-10 协同清理项 |

### 7.3 A / B 类重复代码行数估算

分两档（取决于是否对基类做"加法式"增强）：

- **最小改造（不增强基类、不对齐 HTML ID）**：仅 `handleEditRecord`(~12) + `handleDeleteRecord` 骨架 via 审计钩子(~22) ≈ **~34 行**。分页/表头因 ID 不匹配仍须保留。
- **推荐改造（基类加 no-op 钩子 + Tableware HTML ID 命名空间化）**：`handleEditRecord`(12) + `handleDeleteRecord`(35) + `updatePagination`(17) + `setupPaginationListeners`(94,复用) + `showEditModal` 整改脚手架(~150) + `getRecordDate/Canteen` 内联(~4) ≈ **~312 行**。

> 注意：核心大方法 `renderTable`(~160)、`handleFormSubmit`(~90)、`updateFormStructure`(~168)、`showEditModal` 复检段(~80)、`showTablewareDetail`(~108) **无法被基类直接吸收**，因数据模型差异（见 7.6）。去重收益集中在"编辑/删除/分页/辅助"层，而非列表与提交层。

### 7.4 需新增到基类的钩子方法（B 类需求）

全部以**默认实现与现状逐字一致**的 no-op/分支形式加入，**对 pesticide/oil/leanMeat 零逻辑影响**：

| 钩子 | 默认行为 | 影响的现有分支 |
|------|----------|----------------|
| `getModuleTitleText()` | 返回现有 title 文案（补 `tableware` 分支） | `updateFormStructure` L721-724 |
| `getRemarkLabel()` / `getRemarkPlaceholder()` | 现有分支（补 `tableware`） | `addRemarkField` L870-882 |
| `extractPointData(pointSection)` | 现有 pesticide/oil/leanMeat 分支 | `handleSubmit` L996-1046 |
| `renderRecordRows(record)` | 现有单列渲染 | `render` L1112-1167 |
| `getDetailContentHTML(record)` | 现有三模块分支 | `showDetailModal` L505-542 |
| `renderRecheckFormHTML(record)` / `renderRecheckHistory(rechecks)` / `saveRecheck(record, data)` | 现有 description 模型 | `showEditModal` L316-329,452-486 |
| `onAfterDelete(record, id)` / `onAfterCorrectiveSave(record)` / `onAfterRecheckSave(record)` | **空实现（no-op）** | 新增审计接入点（仅 Tableware 覆写） |
| `idPrefix` 配置 或 DOM ID 命名空间化 | 现有 `${moduleName}_*` 选择器不变 | `setupPaginationListeners`/`updatePaginationUI`/`updateFormStructure` |

**对三模块影响评估**：所有钩子默认实现与现状一致 → 逻辑零回归；`onAfter*` 默认空实现 → 三模块不写审计（与现状相同）。风险仅来自"改写基类现有方法"本身（见 7.6 风险 2），通过"仅新增、不改现有签名/分支"可规避。

### 7.5 预计子类代码量级

- **最小方案**：~ **950–1000 行**（几乎全保留，仅删 ~34 行 + 覆写少数方法）。
- **推荐方案**：~ **650–750 行**（删 ~300 行脚手架；保留 C 类点位管理 ~200 + 覆写 render/submit/form/detail ~400 + 审计钩子 ~20）。

### 7.6 风险点（可能导致三模块回归 / 运行时故障）

1. **数据模型根本差异**：Tableware 是"1 记录 = N 点位（atpPoints 数组）"，基类是"1 记录 = 1 点位"。`render()` 与 `handleSubmit()` 必然自定义，去重收益有限——这是本重构投入产出比偏低的核心原因。
2. **基类改造本身**：若在基类 `showEditModal`/`render` 抽钩子时改写现有逻辑，可能误伤三模块。缓解：只新增钩子、默认实现逐字照搬、加手动回归（三模块各提交一条记录 → 编辑 → 复检 → 删除）。
3. **DOM ID 命名空间不一致**：基类选择器全用 `${moduleName}_*`（如 `tableware_paginationInfo`、`btnAddtablewarePoint`），而 Tableware 的 index.html 用非前缀 ID（`paginationInfo`、`btnAddAtpPoint` 等）。复用分页/表头必须二选一：① 重命名 index.html 的 tableware 区块 ID（中风险，需精确编辑）；② 给基类加 `idPrefix` 配置（低风险，但扩大基类配置面）。
4. **审计日志缺口（合规风险）**：基类 `handleDeleteRecord`/`showEditModal` **不写审计**，而 Tableware 现通过 `auditLogService.logOperation` 写审计（P1-09 双系统）。若直接复用基类而不加 `onAfter*` 钩子，Tableware 的删除/编辑审计将丢失 → 必须经由钩子补回。
5. **window 全局清理联动**：改为类后 `window.initTableware` / `window.showTablewareDetail` / `window.renderTablewareData` 由实例方法取代。需同步更新调用点，否则运行时报错：
   - `js/main.js:244`（`initTableware()` → `new TablewareModule(...)`）
   - `js/utils/SampleDataGenerator.js:35`（`initTableware()` 调用）
   - `window.renderTablewareData`（快速访问路径设置，需改为实例方法或事件）
   - 详情展示现经 `.result-value` 点击委托（非内联），改为 `this.showDetailModal` 即可，无需 window。
6. **报备要求**：基类属共享代码、影响三模块，依项目规范 `PROJECT_CONVENTIONS` 规则二（方法偏离预先报备）应事先报备并灰度；建议先在基类加 no-op 钩子（独立提交），再单独改造 Tableware。

---

## 8. 决策记录

经成本效益评估：推荐方案需改动共享基类（影响pesticide/oil/leanMeat三个现役模块）+ index.html ID命名空间化，风险等级中，仅可消除约300行重复代码，且核心方法（render/handleSubmit）因数据模型差异（1记录=N点位 vs 1记录=1点位）无法真正复用。鉴于当前P1还有21项待处理（安全相关，优先级更高），决定暂缓实施本项重构。本方案文档保留作为未来参考，若后续新增检测模块需要更好的基类抽象，可重新评估。
