# PHASE 2.5 · 远端新增提交与审计修复点的覆盖确认

- **对比范围**：`f08e72e..7343a8a`（本次拉入的 8 个业务提交，+1495/-10，15 个文件）对 Phase 2 已确认的 23 个 P1 修复点
- **方法**：只读 diff 比对 + 关键文件复核；**未重新审计、未修改应用代码、未推送**
- **结论一句话**：**1 项部分覆盖（AUD-025 的修复模式已落地但 oil 未修）、1 项部分缓解（AUD-020 看板路径）、其余 21 项未覆盖；AUD-003 的 sink 范围无扩大，但新增了两处"注释约定手工同步"的判定副本，构成对 RC-09 修复方案的直接影响。**

## 一、覆盖状态对照表

| 审计项（相关 RC） | 这批提交是否触及 | 状态判定 | 关键依据 |
|---|---|---|---|
| **AUD-025** 油脂统计 fail-open（RC-09） | **部分触及（模式层）** | **部分覆盖：模式已落地，oil 未修** | 新增 `backend/lib/tablewareVerdict.js`（单一判定规则 + `TABLEWARE_PASS_SQL` 供 SQL 同源引用 + unknown 不判合格）；`recordRoutes.js:182` 新增 `WHEN 'tableware' THEN ...`；**oil 分支逐字未改**（仍 `colorLevel NOT LIKE '%不合格%'`）；`guestRoutes.js` 未在本次改动文件内 |
| **AUD-020** 缓存/导出截断（RC-07） | 部分触及 | **部分缓解（非覆盖）** | 肉蛋子卡改由服务端聚合驱动（`recordRoutes.js` 新增 `byMeatType`，`Dashboard.applyServerStats` 消费）→ 看板不再依赖本地缓存完整性；`MAX_RECORDS_LIMIT` / `Storage.maxSyncRows` / `ExportService` 的 limit **均未改动** |
| **AUD-003** 输出编码（RC-05） | 触及前后端渲染 | **未覆盖；范围无扩大** | `Dashboard.js` 的 `innerHTML` 数量 **10 → 10（无新增）**；新渲染走 `textContent`（`updateLeanMeatCards` 用 `getElementById(...).textContent`）；新增 HTML 为静态模板，无用户输入插值 |
| AUD-021 / AUD-022（RC-06 客户端同步） | 否 | 未覆盖 | 未涉及 `Storage`/`AdaptiveUploadQueue`/409 语义 |
| AUD-024（P2 状态重置） | 否 | 未覆盖 | 未改 `resolveWritableStatus` |
| AUD-026（P2 同步绕过审计） | 间接触及 | 未覆盖 | `syncRoutes.js` 仅新增 3 处 `testType: store` 传参（服务于餐具写入侧自洽），未涉及审计写入 |
| 其余 17 项（001/002/004/005/006/007/008/009/010/012/014/015/016/017/027/039/044/047） | 否 | 未覆盖 | 无对应文件/语义改动；**无 schema 变更、无 migration 新增** |

## 二、三项重点发现（对 Phase 3 的直接输入）

### 1. AUD-025 的修复方案被"部分预置" → 方案选择空间收窄

代码库已出现**可复用的正确模式**（本批为餐具而建）：

- **单一规则文件**：`tablewareVerdict.js` 把"顶层 result 优先、为空回退点位、最差点胜出、unknown 不判合格"收敛到一处，并在文件头注明全部消费方（内部统计/对外统计/对外明细/前端）。
- **SQL 与 JS 同源**：`TABLEWARE_PASS_SQL` 片段由同一文件导出，被 `recordRoutes.js`（员工端统计）与 `openApiRoutes.js`（对外统计）**逐字引用**（此前两处各写一份）。
- **unknown 语义正确**：顶层为空且无点位 → `unknown`，**不推定合格**——与 AUD-025 的修复原则一致。
- **写入侧自洽**：`fillTablewareAggregate` 在写入归一时补写记录级 `result`（只填不覆盖、未提交点位不补写），并已接入 `recordRoutes`（create/update）与 `syncRoutes`（3 处）。

**对 Phase 3 的影响**：AUD-025 **不应**新建一个跨类型的 `normalizeConclusion()` 大抽象，而应**按既有模式扩展**——为 oil（以及 pathogen/leanMeat）建立同构的判定模块，把 `recordRoutes` 内部统计、`guestRoutes` 访客统计、`openApiRoutes` 对外统计、`openApiScope` 明细统一到同一规则源。RC-09 的"统一判定"方向不变，但实现路径被这批代码具体化为"**一类型一模块 + SQL 片段同源 + unknown 不判合格**"。

### 2. AUD-020 的"服务端聚合"缓解路径已被验证可行

肉蛋子卡从"只读本地缓存"改为"以服务端 `byMeatType` 聚合为准"（含固定的 7 个卡片键、无数据为 0/null），直接消除了看板数字受本地缓存截断/漂移影响的问题。

**对 Phase 3 的影响**：AUD-020 的修复可沿用两条腿——**能聚合的指标走服务端聚合**（本批已示范契约形态：键固定 + null 语义 + 前端只渲染），**需要明细的走完整读取契约**（分页/流式/显式拒绝三选一）。同时 `byMeatType` 可作为"服务端聚合契约"的先例参考。

### 3. 新增两处"注释约定手工同步"的判定副本 → RC-09 的结构性问题仍在发生

本批新增：

- `Dashboard.normalizeMeatKey`（前端手写副本，注释："与后端 lib/leanMeatCategory.js **逐字一致**，改动必须两边同步"）
- `Dashboard.isQualified` 的餐具点位回退（注释："规则与后端 lib/tablewareVerdict.js **逐字一致**，改动必须两边同步"）
- `tablewareVerdict.js` 文件头亦自述："前端 Dashboard.isQualified（同一规则的手写副本，改动需同步）"

**对 Phase 3 的影响**：这与 NF-C-02（8 份 escapeHtml 分叉）同构，只是发生在**判定逻辑层**。前端无法直接 import 后端模块，因此 AUD-025 的统一必须处理该约束，**首选方案是"服务端聚合成为唯一计算源、前端只渲染"**（本批对肉蛋子卡已经这样做，但 `isQualified` 仍保留手写判定 → 同一文件内两种范式并存）。若不解决，AUD-025 的"统一"会变成新增第 5、6 处副本。

## 三、需要提醒的风险与边界注记

1. **写入侧行为已改变（数据形态）**：`fillTablewareAggregate` 会在写入时补写 `result`。餐具历史数据仍依赖读取侧回退兜底；`check-tableware-consistency.mjs` 正是用于发现"写入侧补写未生效/绕过写入路径的数据导入"。这与审计项不冲突，但 Phase 3 若做 AUD-025 的统一，需把"餐具的写入侧自洽"纳入同一语义模型，避免两套规则并存。
2. **`TABLEWARE_PASS_SQL` 与 JS 版在 warn/fail 细分上不等价**：SQL 版只有 pass / not-pass；JS 版区分 `warn` 与 `fail`。当前统计只消费 pass/not-pass，**无实际差异**；但"逐字同源"的声明应以此为边界注记（后续若统计要区分警戒率，需补 SQL 分支）。
3. **无 schema 变更**：本批未新增 migration，因此 **AUD-008 的修复窗口未被这批提交改变**（补丁 migration 方案仍然成立）。
4. **可复用的验证资产（对 Phase 3 有价值）**：
   - `backend/tests/records/tableware-verdict.test.mjs`（规则单测）
   - `backend/tests/records/stats-verdict.integration.test.mjs`（隔离库统计口径集成）
   - `backend/scripts/check-tableware-consistency.mjs`（**只读巡检 + 跨 schema + 退出码可挂告警**）——该模式可直接复用于"四出口口径一致性"与 AUD-020 的完整性巡检。

## 四、结论

| 判定 | 项目 |
|---|---|
| **部分覆盖（模式已落地，缺陷未修）** | AUD-025（oil 仍 fail-open；餐具路径已成为修复模板） |
| **部分缓解（非覆盖）** | AUD-020（看板走服务端聚合；列表/导出截断仍在） |
| **未覆盖（范围无扩大）** | AUD-003（无新增 sink；但新增 2 处判定副本） |
| **未覆盖** | 其余 20 项（含 AUD-021/022、RC-02 全组、RC-03 全组、RC-04 全组） |

**对既定流程的影响**：本批提交**不改变** 23 个 P1 的结论与 severity 状态；但对 Phase 3 有三处实质输入——① AUD-025 的方案从"新建统一抽象"收缩为"按既有模式扩展 + 服务端聚合为唯一源"；② AUD-020 增加一条已验证的"服务端聚合"缓解路径；③ AUD-003/C-02 类"多份副本"风险在判定层新增两例，需在统一方案中一并处理。Astra 仲裁清单不变（6 项 severity PENDING + AUD-027 P1_REVIEW + Phase 2.5 的 3 项边界扩展）。

> 声明：本文件为只读确认，未修改任何应用代码，未提交、未推送；远端提交已通过 fast-forward 拉取到本地（HEAD = `7343a8a`）。
