# FIX-P0-11：数据看板"合格率"统计错误，"不合格"记录被误判为合格

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P0-11`（建议编号，性质为数据正确性缺陷而非安全漏洞；因影响核心业务指标"合格率"准确性，暂归 P0 系。**最终归类待审阅方确认**——若审阅方认为应新增独立类别如 `BUG-01`，可调整） |
| **优先级** | 🔴 P0 高危（核心业务指标失真，可能掩盖食品安全问题） |
| **影响文件** | `js/modules/Dashboard.js`（7处）、`js/services/ExportService.js`（1处）、`index.html`（2处代码块3个判断）、`js/modules/Tableware.js`（2处）— 共 **12 处判断逻辑** |
| **预估工时** | 1h |
| **关联问题** | - |
| **状态** | ✅ 已完成（v2，2026-07-02） |
| **完成日期** | 2026-07-02 |

---

## 版本修订记录

| 版本 | 日期 | 修订内容 |
|------|------|---------|
| **v1** | 2026-07-02 | 初版登记，修复 5 处代码块（Dashboard.js `getStats()` 2 处 + index.html 2 处代码块 + ExportService.js 1 处）。初版排查基于当前代码静态搜索，覆盖范围不完整。 |
| **v2** | 2026-07-02 | 经历史演变追溯（`git show d101cba` 逐行比对），发现 v1 遗漏 7 处：Dashboard.js `getLeanMeatStatsByType()` 1 处 + `calculateCanteenTrends()` 2 处 + `calculateCanteenPassRate()` 2 处 + Tableware.js 2 处（`allPassed` 数据逻辑 + 打印模板颜色）。v2 补充修复全部 7 处，并执行数值验证通过。同时按证据强度分级修正历史影响面评估。 |
| **v3** | 2026-07-02 | 收尾补充核查（文档级，无代码变更）：①全仓库 grep（含 `backend/`）确认 4 文件 12 处修复无遗漏；②逐一排查其他检测模块（Pathogen/GenericTest/BaseTestModule/GuestDashboard 等）确认无同构 bug——GenericTest.js 全程用 `=== '合格'` 严格相等免疫子串问题，Pathogen.js 用阴性/阳性体系不含"合格"字串；③对 `getLeanMeatStatsByType`/`calculateCanteenTrends`/`calculateCanteenPassRate` 分别执行 `git log -S` 独立考古，确认前两者与 d101cba 同源、前者由 f4e5458 独立引入，补 §4.3.1 逐函数存活时长。 |

> **v1 排查方法学反思**：v1 仅用 `search_content`（基于 ripgrep）搜索当前代码中的 `includes('合格')`，但该工具对中文字符存在编码匹配问题（返回 0 结果），导致 v1 排查依赖手工 `git diff` 而非全量 grep。v2 改用 `grep -rn` 命令行工具直接搜索，发现 v1 遗漏的 7 处。**教训：对非 ASCII 字符串搜索，应交叉验证多种工具。**

---

## 1. 问题描述

数据看板"合格率"统计存在逻辑缺陷：使用 `String.includes('合格')` 判断检测结果是否合格时，未排除"不合格"字符串的子串包含关系。由于 JavaScript 的 `String.includes()` 是子串匹配，`'不合格'.includes('合格')` 返回 `true`，导致**"不合格"记录被误判为合格**，使合格率统计虚高。

该缺陷影响数据看板的合格率展示（Dashboard.js / index.html）、导出的 Excel/PDF 报告中的合格率（ExportService.js）、肉蛋品种分类统计（Dashboard.js `getLeanMeatStatsByType`）、食堂趋势图与合格率图表（Dashboard.js `calculateCanteenTrends` / `calculateCanteenPassRate`）、以及餐具检测的"全部合格"判定与打印模板（Tableware.js）。**食品安全检验系统的核心输出指标即合格率**，合格率虚高可能掩盖真实的食品安全风险，属高危数据正确性问题。

## 2. 根因分析

### 2.1 根本原因

`String.prototype.includes()` 执行子串匹配，不区分语义。中文检测结果"不合格"包含子串"合格"，因此 `'不合格'.includes('合格')` === `true`。原代码仅用 `result.includes('合格')` 判断合格，未排除"不合格"这一反向语义的子串包含，导致逻辑反转。

### 2.2 受影响代码位置清单（共 12 处）

#### v1 修复（5 处代码块，6 个判断表达式）

| # | 文件 | 函数/位置 | 修复前表达式 |
|---|------|----------|-------------|
| 1 | `js/modules/Dashboard.js` | `getStats()` ATP 统计分支 | `result === '合格' \|\| result.includes('合格')` |
| 2 | `js/modules/Dashboard.js` | `getStats()` 其他类型分支 | `result.includes('合格') \|\| colorLevel === '合格'` |
| 3 | `index.html` | 餐具统计 forEach | `r.result && r.result.includes('合格')` |
| 4 | `index.html` | 农药/油脂统计 forEach（result + pestResult） | `r.result.includes('合格')` / `r.pestResult.includes('合格')` |
| 5 | `js/services/ExportService.js` | 导出合格率计算 | `r.result?.includes('合格') \|\| r.colorLevel === '合格'` |

#### v2 补充修复（7 处，v1 遗漏）

| # | 文件 | 函数/位置 | 修复前表达式 | 业务含义 |
|---|------|----------|-------------|---------|
| 6 | `js/modules/Dashboard.js` | `getLeanMeatStatsByType()` L711 | `result.includes('合格')` | 肉蛋农残按品种（猪/羊/牛/禽/鱼/蛋）合格率统计 |
| 7 | `js/modules/Dashboard.js` | `calculateCanteenTrends()` L1291 | `result === '合格' \|\| result.includes('合格')` | 食堂趋势图-餐具ATP点位 |
| 8 | `js/modules/Dashboard.js` | `calculateCanteenTrends()` L1304 | `result.includes('合格') \|\| colorLevel === '合格'` | 食堂趋势图-其他类型 |
| 9 | `js/modules/Dashboard.js` | `calculateCanteenPassRate()` L1448 | `result === '合格' \|\| result.includes('合格')` | 食堂合格率图表-餐具ATP点位 |
| 10 | `js/modules/Dashboard.js` | `calculateCanteenPassRate()` L1462 | `result.includes('合格') \|\| colorLevel === '合格'` | 食堂合格率图表-其他类型 |
| 11 | `js/modules/Tableware.js` | L326 `allPassed` 判定 | `!res.includes('合格')` | 餐具检测"全部合格"判定逻辑（"不合格"点位被当作通过） |
| 12 | `js/modules/Tableware.js` | L1208 打印模板 | `p.res.includes('合格')?'text-green-600':'text-red-600'` | 打印/导出HTML模板中"不合格"显示为绿色 |

> **Tableware.js 其他 3 处 `includes('合格')`（L425/L435/L1026）经核实不是 bug**：这些位置采用"判断顺序"方案——函数内先检查 `result.includes('不合格')` 提前返回/着红色，再检查 `includes('合格')`，已正确处理子串包含问题（代码含 `// 修复：调整判断顺序，先判断"不合格"` 注释）。

### 2.3 业务口径

经 2026-07-02 业务方裁定：**仅"合格"计为合格**，"警戒""不合格"等其余结果均计为不合格。修复后表达式满足该口径：警戒类结果不含"合格"子串，自动归入不合格分支。

### 2.4 v1 遗漏原因分析（"3→2"追溯结论）

git 考古发现 `d101cba`（2025-12-12）创建 Dashboard.js 时，`.includes('合格')` bug 出现在旧路径 `food-safety-system/js/modules/Dashboard.js` 的 **3 处**（L408 `getStats()` / L687 `calculateCanteenTrends()` / L840 `calculateCanteenPassRate()`）。

v1 仅修复了 `getStats()` 的 2 处（含 `f08600b` 2025-12-26 新增的 ATP 分支），**遗漏了 `calculateCanteenTrends()` 和 `calculateCanteenPassRate()` 中的 2 处原始 bug**，以及 `f4e5458`（2025-12-30）新增的 `getLeanMeatStatsByType()` 1 处。这 3 处函数从未被合并或删除（**情形 c：当前仍以原始 bug 形式存在**），v2 已全部补充修复。

## 3. 修复方案（已于 2026-07-02 完成，v2）

### 方案 A（已采用）

在所有 `includes('合格')` 判断后追加 `&& !result.includes('不合格')` 排除条件，确保"不合格"不被误判：

```diff
- if (result === '合格' || result.includes('合格')) {
+ if (result.includes('合格') && !result.includes('不合格')) {
      passCount++;
  }
```

修复后统一表达式：`result.includes('合格') && !result.includes('不合格')`（对 `r.result` / `r.pestResult` / `r.colorLevel === '合格'` 各分支按同样原则处理；`colorLevel === '合格'` 为严格相等无需改）。

### 修改文件与位置

**v1 修复（5 处代码块）**：
- `js/modules/Dashboard.js`：`getStats()` ATP 分支（L866）、其他类型分支（L918）
- `index.html`：餐具统计（L936）、农药/油脂统计（L945-946）
- `js/services/ExportService.js`：导出合格率（L601）

**v2 补充修复（7 处）**：
- `js/modules/Dashboard.js`：`getLeanMeatStatsByType()`（L711）、`calculateCanteenTrends()` ATP 分支（L1291）、`calculateCanteenTrends()` 其他类型分支（L1304）、`calculateCanteenPassRate()` ATP 分支（L1448）、`calculateCanteenPassRate()` 其他类型分支（L1462）
- `js/modules/Tableware.js`：`allPassed` 判定（L326）、打印模板颜色（L1208）

### 方案 B（备选）

改用严格相等 `result === '合格'`，但会丢失对"合格（常规）"等含修饰后缀的合规结果兼容，可能导致部分合格记录被漏统计。当前未采用，保留 `includes` 宽松匹配 + 排除"不合格"的反向条件组合。

## 4. 历史影响面评估（git 追溯完整证据链）

> 本节为本次登记最重要部分，基于 `git log --follow -S` 逐文件追溯，不回避、不淡化。

### 4.1 Bug 首次引入时间（逐文件追溯）

#### 4.1.1 `js/modules/Dashboard.js` 与 `js/services/ExportService.js`

- **首次引入 commit**：`d101cba`（2025-12-12，"重构系统架构：优化看板功能和导出模块"）
- **追溯证据**：该 commit 首次创建 `food-safety-system/js/modules/Dashboard.js`（新增 839 行）与 `food-safety-system/js/services/ExportService.js`（新增 876 行），创建时即含缺陷判断：
  - `ExportService.js` L477：`result.includes('合格') || result.includes('通过') || result.includes('正常') || result.includes('良好')`
  - `Dashboard.js` L408/687/840：`r.result?.includes('合格') || r.colorLevel === '合格'`（3 处，分属 `getStats()` / `calculateCanteenTrends()` / `calculateCanteenPassRate()`）
- **存活起点**：2025-12-12

#### 4.1.2 `index.html`

- **首次引入 commit**：`608d567`（2026-04-22，"fix: 删除重复的 quickViewBtn 变量声明 - 保留完整版本实现"）
- **追溯证据**：该 commit 在 index.html 新增餐具/农药/油脂合格率统计逻辑，直接添加缺陷表达式
- **存活起点**：2026-04-22

#### 4.1.3 `js/modules/Tableware.js`

- Tableware.js 中 `allPassed` 判定（L326）与打印模板颜色（L1208）的 `includes('合格')` 引入时间未单独追溯（Tableware.js 早在 `d101cba` 即存在），但这两处属同类子串包含缺陷，存活时间同样自 2025-12-12 起。

### 4.2 Bug 引入后的修改历史链（是否曾改对又改错）

通过 `git log -S "includes('合格')"` 追溯 Dashboard.js 历史修改 commit：

| commit | 日期 | 改动性质 | 是否修复 |
|--------|------|---------|---------|
| `d101cba` | 2025-12-12 | 文件创建，首次引入 `includes('合格')` 缺陷（3 处） | ❌ 引入 |
| `f08600b` | 2025-12-26 | `getStats()` 将 `result === '合格'` 改为 `result === '合格' \|\| result.includes('合格')`，**新增第 4 处缺陷** | ❌ 扩散 |
| `f4e5458` | 2025-12-30 | 代码重构（肉蛋农残品种筛选），新增 `getLeanMeatStatsByType()` 含缺陷，**新增第 5 处** | ❌ 扩散 |
| v1 修复 | 2026-07-02 | 修复 `getStats()` 2 处 | ✅ 部分 |
| v2 修复 | 2026-07-02 | 补充修复剩余 5 处 + Tableware 2 处 | ✅ 完成 |

**结论**：Bug 自 2025-12-12 引入后**从未被修正**，反而在 2025-12-26 和 2025-12-30 两次扩散。无"改对又改错"的反复，属单向持续存在。v1 仅修复 2/7 处，v2 补齐剩余 5/7 处。

### 4.3 Bug 存活时间跨度

| 文件 | 引入日期 | 修复日期 | 存活时长 |
|------|---------|---------|---------|
| `Dashboard.js` | 2025-12-12 | 2026-07-02 | **约 6.7 个月（203 天）** |
| `ExportService.js` | 2025-12-12 | 2026-07-02 | **约 6.7 个月（203 天）** |
| `Tableware.js` | 2025-12-12 | 2026-07-02 | **约 6.7 个月（203 天）** |
| `index.html` | 2026-04-22 | 2026-07-02 | **约 2.7 个月（71 天）** |

#### 4.3.1 按函数粒度的存活时长（v3 补充，不得笼统合并）

> 上表按文件汇总，但 `Dashboard.js` 内 4 个受影响函数的引入时间并不相同：3 个与 `d101cba`（2025-12-12）同源，`getLeanMeatStatsByType()` 则由 `f4e5458`（2025-12-30）独立引入。逐函数存活时长如下（经 `git log --follow -S "<函数名>"` 独立复核）：

| 函数 | 文件 | 首次引入 commit | 引入日期 | 修复日期 | 存活时长 | 是否与 d101cba 同源 |
|------|------|----------------|---------|---------|---------|-------------------|
| `getStats()`（2 处） | `Dashboard.js` | `d101cba`（后 `f08600b` 2025-12-26 扩散 ATP 分支） | 2025-12-12 | 2026-07-02 | **约 203 天** | ✅ 同源 |
| `calculateCanteenTrends()`（2 处） | `Dashboard.js` | `d101cba` | 2025-12-12 | 2026-07-02 | **约 203 天** | ✅ 同源 |
| `calculateCanteenPassRate()`（2 处） | `Dashboard.js` | `d101cba` | 2025-12-12 | 2026-07-02 | **约 203 天** | ✅ 同源 |
| `getLeanMeatStatsByType()`（1 处） | `Dashboard.js` | `f4e5458` | 2025-12-30 | 2026-07-02 | **约 184 天（约 6.0 个月）** | ❌ 独立引入（晚 18 天） |

**结论**：`getLeanMeatStatsByType()` 存活约 184 天，短于其余 3 个函数（约 203 天）约 18 天，因其由 `f4e5458`（2025-12-30）独立引入，与 `d101cba`（2025-12-12）不同源。原 §4.3 文件级汇总将 Dashboard.js 笼统记为 203 天，v3 予以逐函数拆分，避免合并时间线掩盖差异。

### 4.4 系统上线与实际使用情况评估（证据强度分级）

#### 4.4.1 系统演变时间线

- **2025-11-29**：`Initial commit: 食品检验系统 (Clean Version)`——田家炳系统（`Tianjiabing_foodtestlab`）起始
- **2025-12-12**：看板与导出模块重构，Bug 引入
- **2026-04-22**：index.html 引入同类 Bug
- **2026-06-16**：`deploy.ps1` 部署脚本首次纳入 git 管理（`1c5c87c`），含 PM2/Nginx 生产配置
- **2026-06-22**：代码审阅启动（REVIEW_GUIDE 审阅开始日期），P0 修复阶段开启
- **2026-07-02**：本 Bug 修复（v1+v2 同日完成）

#### 4.4.2 生产环境部署证据

据 `RG_01_SYSTEM.md` §1.2 生产部署口径，系统已具备完整生产部署：

| 项 | 值 |
|----|----|
| 部署环境 | 腾讯云 Windows Server |
| 项目目录 | `C:\zhuhaiyizhong` |
| PM2 进程名 | `zhuhaiyizhong-api` |
| 生产 IP | `159.75.106.179:8082`（见 P1-13 闭环记录） |
| 生产数据库 | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`（见 P1-26 闭环确认） |
| 初始账号 | admin / operator / viewer（见 P0-05 seed.js 修复记录） |

#### 4.4.3 历史影响面结论（按证据强度分级）

**⚠️ 存在历史错误展示风险。** 按证据强度分为两个区间：

**确证段（2026-06-16 ~ 2026-07-02，约 16 天）**：

此区间有明确生产部署配置证据（`deploy.ps1` 入库含固定生产 IP `159.75.106.179:8082`、PM2 进程名 `zhuhaiyizhong-api`、生产数据库路径 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`），系统已具备完整生产运行条件。**可确定性建议业务方核查此区间的看板数据与导出报告**，确认是否存在因合格率虚高而遗漏的真实不合格事件。

**推断段（2025-12-12 ~ 2026-06-16，约 6 个月）**：

此区间仅有"系统具备技术条件"的间接证据（代码已开发完成、田家炳系统名表明其为中学食堂定制开发）。**该阶段系统是否已实际投入日常使用未经证实**，本次审计不单方面认定其已产生实际影响。该阶段系统实际使用情况需业务方自行确认，若确认已投入使用，则同样存在合格率虚高风险。

#### 4.4.4 历史导出报告回溯可行性

- `ExportService.js` 采用前端导出（jsPDF / html2canvas / Excel），**导出文件直接下载到客户端浏览器，服务器端不留存历史导出文件**，因此**无法从服务器回溯检查已生成分发的历史 Excel/PDF 报告**；
- 数据库（SQLite `zhuhaiyizhong.db`）保留了历史检测记录，可通过查询 `result` 字段含"不合格"的记录数量，评估历史期间受影响的"不合格"记录规模，从而推断合格率虚高的程度；
- **建议**：业务方核查确证段（2026-06-16 ~ 2026-07-02）基于本系统看板或导出报告做出的食品安全决策；对推断段（2025-12-12 ~ 2026-06-16），若确认系统已投入使用则同等核查。

### 4.5 v3 收尾补充核查（2026-07-02，文档级，无代码变更）

#### 4.5.1 全仓库 grep 最终覆盖范围确认

重新执行全仓库 grep（含 `backend/`，不限定目录）：

```bash
grep -rln "includes('合格')" --include="*.js" --include="*.html" .
```

命中文件清单（共 4 个）：

1. `index.html` — 3 处判断，均已追加 `&& !r.result.includes('不合格')` / `&& !r.pestResult.includes('不合格')` ✅
2. `js/modules/Tableware.js` — 5 处 `includes('合格')`：
   - `allPassed` 判定（L327）：`if (!res.includes('合格') || res.includes('不合格')) allPassed = false;` ✅ 已排除
   - 打印模板（L1209）：`(p.res.includes('合格') && !p.res.includes('不合格'))` ✅ 已排除
   - `getResultIcon` / `updateResultFieldStyle` / `getResultClass`（L425/L435/L1026）：采用判断顺序方案（先检查 `includes('不合格')` 提前返回/着红色），顺序依赖但逻辑正确 ✅
3. `js/modules/Dashboard.js` — 7 处判断（`getStats()` 2 处 + `getLeanMeatStatsByType()` 1 处 + `calculateCanteenTrends()` 2 处 + `calculateCanteenPassRate()` 2 处），均已追加 `&& !result.includes('不合格')` ✅
4. `js/services/ExportService.js` — 1 处判断（L598），已追加 `&& !r.result?.includes('不合格')` ✅

`backend/` 无任何 `includes('合格')` 命中（后端不参与合格率字符串判断）。**全仓库无遗漏的同类缺陷。**

#### 4.5.2 其他检测模块同构 bug 排查（最高警惕标准）

`js/modules/` 下实际存在的模块文件：`AuditLog.js`、`BackupRestore.js`、`BaseTestModule.js`、`Dashboard.js`、`FormBuilder.js`、`GenericTest.js`、`GuestDashboard.js`、`Pathogen.js`、`Tableware.js`、`UserManagement.js`。

> 说明：任务提及的 `Pesticide.js` / `EdibleOil.js` / `LeanMeat.js` / 水质检测模块**均不存在为独立文件**。农药残留、食用油品质、肉蛋农残三类检测由统一的 `GenericTest.js` 类按 `moduleName`（`pesticide` / `oil` / `leanMeat`）分发处理。

比照 Tableware.js 发现的两类 bug 模式逐一核查：

| 模块 | 文件 | (a) allPassed 式整单合格判定（未排除"不合格"子串） | (b) 打印/导出模板用 `includes('合格')` 判色 | 核查结论 |
|------|------|----------------------------------------------|------------------------------------------|---------|
| 餐具洁净度 | `Tableware.js` | L327 已修复（含排除） | L1209 已修复；L425/L435/L1026 顺序依赖式（已正确） | v2 已修复 ✅ |
| 病原体 | `Pathogen.js` | 无（全文件不含"合格"字串，采用阴性/阳性判定体系，无 `includes`/`allPassed` 逻辑） | 无 | 无此类逻辑 ✅ |
| 农药/油脂/肉蛋 | `GenericTest.js` | 无 `allPassed`；复检 `isPassed` 用 `result === '合格'`（严格相等，L464）；列表 `isPass` 用 `result === '合格'`（L1114） | 详情/列表颜色均用 `=== '合格'` 严格相等（L513/L526/L538/L634/L1145），无 `includes('合格')` | **不存在 bug** ✅（严格相等免疫子串问题） |
| 基类 | `BaseTestModule.js` | 无（仅数据 CRUD/分页/缓存，无合格判定） | 无 | 无此类逻辑 ✅ |
| 访客看板 | `GuestDashboard.js` | 无（全文件不含"合格"字串） | 无 | 无此类逻辑 ✅ |
| 数据看板 | `Dashboard.js` | 7 处已修复（含排除） | — | v2 已修复 ✅ |
| 导出 | `ExportService.js` | — | L598 已修复（含排除） | v2 已修复 ✅ |
| 其余（AuditLog/BackupRestore/FormBuilder/UserManagement） | — | 非检测模块，无合格判定逻辑 | 无 | 无此类逻辑 ✅ |

**补充排查结论**：除已修复的 12 处外，**未发现新的同构 bug**。`GenericTest.js`（农药/油脂/肉蛋三类共用）全程使用 `=== '合格'` 严格相等判定，天然免疫"不合格"子串包含问题（即文档 §3 方案 B 的安全写法）；`Pathogen.js` 采用阴性/阳性体系，不含"合格"字串。**本次排查无需产生 FIX_P0-11 v3 代码修复，亦无需独立登记新缺陷。**

> 附带观察（非 P0-11 范畴，仅记录）：`GenericTest.js` 列表渲染（L1145）对食用油"警戒"记录显示为红色，而详情弹窗（L526）显示为黄色，存在 UI 颜色不一致；此为独立 UI 问题，不影响合格率统计正确性，不纳入本次修复。

#### 4.5.3 三函数独立 git 考古复核

针对 `getLeanMeatStatsByType()`、`calculateCanteenTrends()`、`calculateCanteenPassRate()` 分别执行 `git log --follow -S "<函数名>"`，结果与 §4.2 原结论一致：

| 函数 | 首次引入 commit | 引入日期 | 是否与 d101cba（2025-12-12）同源 |
|------|----------------|---------|-------------------------------|
| `calculateCanteenTrends()` | `d101cba` | 2025-12-12 | ✅ 同源 |
| `calculateCanteenPassRate()` | `d101cba` | 2025-12-12 | ✅ 同源 |
| `getLeanMeatStatsByType()` | `f4e5458` | 2025-12-30 | ❌ 独立引入（晚 18 天） |

逐函数存活时长见 §4.3.1。三者引入时间已分别列出，未笼统合并。

## 5. 验收标准

### 5.1 v1 数值验证（2026-07-02 已通过）

构造模拟数据：2 条记录，`atpPoints` 分别为 `[{res:'合格'}]` 和 `[{res:'不合格'}]`。

**修复前（Bug 逻辑）**：count=2, passCount=2, passRate=100% ← "不合格"被误判为合格，虚高

**修复后（当前逻辑）**：count=2, passCount=1, passRate=50% ← 正确

### 5.2 v2 补充数值验证（2026-07-02 已通过）

对 v2 新修复的 3 个函数场景分别验证（每个场景 2 条记录，1 条合格 + 1 条不合格，预期 passRate=50%）：

```
=== 场景1: getLeanMeatStatsByType 肉蛋品种统计 ===
count=2, passCount=1, passRate=50%

=== 场景2: calculateCanteenTrends 食堂趋势图-餐具ATP ===
total=2, passed=1, passRate=50%

=== 场景3: calculateCanteenTrends 其他类型分支 ===
total=2, passed=1, passRate=50%
```

全部通过（passRate=50% 正确，2 条中 1 条合格）。

### 5.3 全仓库最终验证

`grep -rn "includes('合格')" js/ index.html` 结果确认：
- 12 处 `includes('合格')` 统计判断均已追加 `&& !result.includes('不合格')` 排除条件 ✅
- Tableware.js 3 处 `includes('合格')`（L425/L435/L1026）通过判断顺序方案（先检查"不合格"提前返回）正确处理 ✅
- **全仓库无遗漏的同类缺陷** ✅

### 5.4 业务口径确认

- [x] 仅"合格"计为合格（2026-07-02 业务方裁定）
- [x] "警戒""不合格"等其余结果均计为不合格
- [x] 12 处代码位置均补充业务口径注释（2026-07-02）

## 6. 备注

- 12 处代码位置已于 2026-07-02 补充业务口径注释，明确"仅合格计为合格，请勿改为宽松匹配"，防止后续维护回退；
- 本缺陷属数据正确性问题，非安全漏洞。暂归 P0 系因其影响核心业务指标准确性，最终归类待审阅方确认；
- v1 遗漏 7 处的原因：排查工具（ripgrep）对中文字符编码匹配异常返回 0 结果，导致依赖手工 git diff 而非全量 grep。v2 改用 `grep -rn` 命令行工具完成全量排查。**教训：对非 ASCII 字符串搜索，应交叉验证多种工具。**
- 历史影响面评估详见 §4.4.3，按证据强度分级：确证段（2026-06-16 ~ 2026-07-02）可确定性建议业务方核查；推断段（2025-12-12 ~ 2026-06-16）需业务方自行确认是否已投入使用。
- v1→v2 的遗漏根因（`search_content` 中文搜索误报 0 命中）已固化为团队工具使用规范，详见 [`docs/AI_TOOLING_NOTES.md`](../../AI_TOOLING_NOTES.md)，形成审计闭环。
