# PHASE 2 — Independent Adversarial Verification · BATCH C（数据完整性 / 浏览器状态 / 输出安全）

- **基线**：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`（执行前后应用代码零改动、零 commit）
- **范围**：AUD-003 / 020 / 021 / 022 / 025 / 027
- **方法**：阶段 1 半盲（仅读 ID/标题/claim/trigger）→ 独立追踪 UI→queue→API→normalization→persistence→render/export 全链路 → 探针复现 → 阶段 2 读第一遍影响/修复/验收做交叉比对
- **探针**：`phase2/probes-batch-c.mjs`（JSDOM + 内存 localStorage + 本地 fake HTTP server；16 项断言全部通过；无业务数据库、无外部网络）
- **本批新增证据形态**：fake HTTP server 记录了完整的 409 冲突-重试请求序列（AUD-022）；真实 `_processQueuedRequests` 驱动的状态机轨迹（AUD-021）

## 结论速览

| Issue | Validity | Reachability | Data consequence | Severity | State corrupt | Persistent corrupt | Silent | Recoverable |
|---|---|---|---|---|---|---|---|---|
| AUD-003 | CONFIRMED | REALISTIC_PRECONDITION | SERVER_STATE（危险 payload 持久化，渲染层注入） | **P1 保持** | YES | NO（DB 内容按设计存储，缺陷在输出编码） | YES | PARTIAL |
| AUD-020 | CONFIRMED | REALISTIC_PRECONDITION | LOCAL_STATE / UI_ONLY（DB 完整） | **P1 保持** | YES（本地语义错误） | NO | YES | YES |
| AUD-021 | CONFIRMED | REALISTIC_PRECONDITION | LOCAL_STATE + 服务端**缺失**用户意图（数据丢失） | **P1 保持** | YES | NO（服务端无错误数据，但有丢失） | YES | NO（编辑内容）/ PARTIAL（幽灵行） |
| AUD-022 | CONFIRMED | REALISTIC_PRECONDITION | **SERVER_STATE（持久化覆盖他人内容）** | **P1 保持** | YES | **YES** | YES | **NO** |
| AUD-025 | CONFIRMED | RARE_PRECONDITION | UI_ONLY（统计输出；DB 完整） | **P2（降级，争议）** | NO | NO | YES | YES（重算即恢复） |
| AUD-027 | CONFIRMED | REALISTIC_PRECONDITION | SERVER_STATE / AUDIT_INTEGRITY | **P1 保持（争议）** | YES | **YES** | YES | **NO**（需备份） |

```
CONFIRMED: 6    PARTIALLY_CONFIRMED: 0    FALSE_POSITIVE: 0
NOT_REPRODUCIBLE: 0    NEEDS_RUNTIME_VERIFICATION: 0
```

---

## AUD-003 · 检测记录字段进入 innerHTML，存在存储型 XSS

**Original claim**：有写入权限的账号保存 HTML/属性闭合字符串到 vegetableType、remark、inspector 等业务字段，其他用户打开列表或详情时被解析为元素与事件属性。

**Validity：CONFIRMED**（DOM injection confirmed；**script execution NOT demonstrated**，与第一遍一致未声称 RCE）

**完整链路**

1. **写入**：`POST/PUT /api/records/:tableName`（`recordRoutes.js:24/280/505`）经 `requireEditorOrAbove`（operator/manager/admin 可写）；后端 `sanitizeObjectKeys`（`sanitize.js:7-13`）**只剔危险键名，不做 HTML 转义**；`validateRecordPayload`（`recordNormalize.js:349-362`）只校验 testDate/canteen/inspector 非空 → **任意 HTML 字符串入库**
2. **读取/渲染**：`Storage` 拉回 → `GenericTest.render` → `tbody.innerHTML = currentRecords.map(...)`（`GenericTest.js:1332`），其中：
   - `vegetableType`/`batchNo`/`meatType`/`testDate`/`canteen`/`oilTemp`… 直接插值（`:1352-1370`）
   - `remark` 同时进入文本与**属性上下文** `title="${r.remark}"`（`:1345-1347`）
   - 详情弹窗 `renderLogs` 的 `log.user/time/action/content` 未转义（`:350`、`:352`）
   - `Pathogen.js:1181` `modal.innerHTML` 插入 `title/sampleId/testDate` 等未转义字段
3. **导出/预览 sink**：`ExportService.generateReportHTML` → `reportPreview.innerHTML`（`:503`）；表格单元格已用 `this._escapeHtml(v)`（`:688`）——**导出表格路径有转义，列表/详情路径没有**（同仓库多份 escapeHtml 实现，未统一）

**现有保护机制（本轮实测）**

- 页面级 CSP **不存在**：`server.js:205-207` 的 CSP 仅对 `/api/*`；Caddy 配置（`deploy.sh:836-841`）只有 HSTS/nosniff/Referrer/X-Frame；`X-XSS-Protection` 已被现代浏览器移除。→ **CSP 不构成 XSS 保护**
- 后端 `sanitizeObjectKeys` = 键名净化（原型污染防护），**不是输出编码**
- 写入需 editor+ 账号（非匿名）

**探针证据**：真实 `GenericTestModule.render` 渲染恶意记录 → 断言 `#audit-table img[onerror]` 与 `#audit-table div[onmouseover]` 均存在（**属性闭合注入成功**）；未触发事件、未执行脚本。

**数据后果七问**

1. Internal incorrect state：渲染层生成攻击者可控的 DOM 节点（含事件属性）
2. User-visible：任何查看列表/详情的用户（含 manager/admin/viewer/guest）页面被注入
3. Server-persisted：恶意字符串按业务字段原样持久化（等待他人渲染触发）
4. Silent：投放无告警；受害者渲染无感知
5. 可察觉/恢复：可通过清理字段恢复；一旦脚本执行（未演示），会话窃取后果不可逆
6. 覆盖/泄露他人数据：可达（以受害者身份操作其可及接口）
7. UI 还是 DB：**DB 存储内容按设计；缺陷在输出编码缺失** → 渲染层 corruption

**阶段 2 比对**：第一遍影响（"可在查看者同源上下文运行脚本……后端去除危险 JSON 键不等于 HTML 输出转义"）准确；reproducer 忠实（只做 DOM 复现、未执行脚本）；未漏保护机制（本轮额外确认 CSP 缺失、Caddy 无 CSP、导出表格已转义）。**修复方向不破坏升级路径**（textContent/属性赋值改造，注意导出预览与打印样式回归）。

**Severity：P1 保持**——写权限即可投放、影响全部查看者（含管理员）、无有效 CSP、影响跨页面操作；但限定描述为"DOM 注入已确认、脚本执行未演示"。

---

## AUD-020 · 列表缓存与报告导出静默截断历史记录

**Original claim**：某类型记录超过 1000/2000 时，Storage 单次取前 1000 条、导出请求 limit=10000 但后端最多 2000，均未按 total 翻页。

**Validity：CONFIRMED**（A 级：2501 条 fake 数据实测 + 源码链路）

**三个数字的确切来源**

| 值 | 位置 | 语义 |
|---|---|---|
| 1000 | `Storage.js:15` `maxSyncRows: 1000` | 前端同步单次请求上限（历史从 200 提到 1000） |
| 2000 | `recordRoutes.js:13` `MAX_RECORDS_LIMIT`，`:251` `Math.min(limit, 2000)` | 后端 take 上限；`:263` 同时返回 `total` |
| 10000 | `ExportService.js:353` `?limit=10000` | 导出请求值，被后端 cap 到 2000 |

**完整链路**：`GET /api/records/:tableName`（`recordRoutes.js:243-278`）返回 `{success, data, total, limit, offset}` → `Storage._syncFromApi` 固定 `?limit=1000&offset=0`（`Storage.js:255`）→ 只取 `response.data`（`:267`），**忽略 total、无 offset 循环** → `_updateLocalCache(mergedData)`（`:311`）→ 导出 `syncDataFromServer` 一次性 `limit=10000` → `_updateLocalCache(data.data)` → `generateReportHTML` 用本地条数（`ExportService.js:596` "总检测记录数：N 条"）

**探针证据（2501 条 fake records）**：只发出 **1 次**请求（`limit=1000`）、缓存恰好 **1000** 条、`total=2501` 被忽略；导出路径数学上 `min(10000, 2000) = 2000 < 2501`，且报告文案取本地条数、无"数据不完整/超过上限"提示。

**数据后果七问**

1. Internal incorrect state：本地缓存被当作"全量数据集"使用（列表/看板/导出）
2. User-visible：较早历史记录消失；旧日期范围报告偏少甚至为空
3. Server-persisted：**无**（服务端数据完整、total 正确返回）
4. Silent：**是**（无任何截断提示；报告自称"N 条"）
5. 可察觉/恢复：难以察觉；数据未丢失，可重新查询/修复读取逻辑恢复
6. 覆盖/泄露他人数据：否（单校范围内读取）
7. UI 还是 DB：DB 完整，**读取与导出不完整** → LOCAL_STATE/UI_ONLY

**阶段 2 比对**：第一遍影响（"历史记录从本地完整视图中消失；较早日期报告可能为空或不完整，却仍按正常报告导出。导出的本地行数保护无法识别服务器已截断的数据"）准确；验收中"2501 条跨日期数据"与本轮实测一致；未漏保护机制（后端 total 存在但前端未用——这本身是证据而非保护）。

**Severity：P1 保持**——食品安全合规报告"声称完整却静默缺数"直接影响对外可信度与审计；触发条件（单类型 >1000/2000 条）在实际补导数据下已经接近（历史已达 481/290/234）。

---

## AUD-021 · 离线临时记录在创建、编辑、删除转换中丢失变更

**Original claim**：临时记录未上传即编辑时，创建应答先替换临时 ID 并出队，后续 updateTemp 只尝试合并已不存在的 create；删除临时记录又被 dirty cache 合并保留。

**Validity：CONFIRMED**（A 级：真实 Storage 状态机 + 真实队列方法驱动）

**状态机与实测轨迹**

| 场景 | 轨迹 | 实测结果 |
|---|---|---|
| A 离线新建→编辑→重连 | 队列 `["create","update_temp"]` → create 处理完成后出队（`:362`）→ `_handleUpdateTemp`（`:725-735`）找不到 create → **no-op** | POST body = `{"result":"合格"}`（**编辑值"不合格"未上传**）；处理后队列 `[]`；本地行被服务端权威响应覆盖（`_replaceTempIdInCache` forceServer）→ **编辑在本地与服务端同时消失** |
| B 离线新建→删除 | `delete()` splice 本地行 → `_updateLocalCache(cached)` 的 pending merge（`:577-592`）从旧 localStorage 读取 `isTemp` 行并 `push` 回 | **幽灵行=true**（本地仍存在，刷新后仍在）；`create` 任务被 `_cleanupTempRequests` 移除=true（服务端不会创建） |
| C create 在途时编辑 | create 已不在队列 → 同 A 的 no-op 分支 | 编辑仅短暂存在于本地，随后被服务端响应覆盖 |
| D create 成功但 update 未合并 | 同 C | 同 A |

**关键代码**：`Storage.js:159-160`（temp → `_queueTempUpdate`）、`:725-735`（仅在 create 仍在队列时合并）、`:693-703`（forceServer 替换）、`:176-199`（删除 + 清理）、`:577-592`（pending merge 复活机制）

**数据后果七问**

1. Internal incorrect state：本地缓存与队列对"用户最后操作"的表达错误（编辑丢失 / 幽灵行）
2. User-visible：修改的内容消失（无提示）；已删除的记录仍在列表
3. Server-persisted：**服务端缺少用户以为已保存的编辑**（数据丢失型）；场景 B 服务端未创建（与删除意图一致）
4. Silent：**是**（编辑无报错、无冲突提示）
5. 可察觉/恢复：编辑内容不可恢复（需重做）；幽灵行可通过清缓存/刷新修补（PARTIAL）
6. 覆盖/泄露他人数据：否
7. UI 还是 DB：本地状态错误 + **服务端缺失应有数据**（不是"错误数据"而是"丢数据"）

**阶段 2 比对**：第一遍影响（"修改被静默丢弃；删除后出现无上传任务的幽灵记录。用户所见和实际持久化状态不一致"）**逐条与本轮实测一致**；第一遍的 probe 结论（编辑丢弃、幽灵行）本轮用真实队列路径完整重现并补充了 POST 负载层面的直接证据；未漏保护机制（`_cleanupTempRequests` 阻止了幽灵行上传，因此场景 B 无服务端副作用）。

**Severity：P1 保持**——静默数据丢失（用户明确点过保存），且幽灵行削弱用户对删除的信任。

---

## AUD-022 · 版本冲突重试只换 version，可能覆盖他人的新内容

**Original claim**：两人从 v1 编辑同一记录；A 写成 v2，B 收到 409，队列把旧完整 payload 的 version 改成服务端版本再提交。

**Validity：CONFIRMED（含服务端持久化覆盖的端到端复现）**

**并发语义契约**

- 服务端 409 响应：`{ error, serverVersion, clientVersion }`（`recordRoutes.js:588-592`）；原子条件更新失败时 `serverVersion:'stale'`（`:606-608`）——**无 latest object、无 ETag、无冲突字段元数据**
- 客户端 409 处理（两处同构）：`AdaptiveUploadQueue.js:166-172` 与 `Storage.js:380-388` —— `payload = { ...payload, version: latestVersion }`，**保留 stale 全量内容**后自动重试（`maxRetries=2`，`:371`）
- 服务端 PUT 契约：`resultDataMode` 默认 `'replace'`（`:538`，整对象替换）；`PROTECTED_FIELDS` 自愈（`:570-581`）只填补"incoming 为空且 existing 非空"的字段，**不阻止非空旧值覆盖新值**

**探针端到端证据（本地 fake HTTP server，日志原文）**

```
PUT /api/records/oil/1 {"version":1,"remark":"A的新内容"} | current.version=1   → A 成功，服务端 v2
PUT /api/records/oil/1 {"version":1,"remark":"原始内容"} | current.version=2   → 409(serverVersion=2)
PUT /api/records/oil/1 {"version":2,"remark":"原始内容"} | current.version=2   → 重试：仅 version 更新，内容为 stale → 覆盖 A
最终 remark="原始内容"（A 的更新丢失，version=3）
```

**最终后果分类：LOST_UPDATE**（A 的更新被 B 的 stale 覆盖；非 SAFE_RETRY、非 MANUAL_CONFLICT、非 LAST_WRITE_WINS 的合并语义——是"整条替换式回退"）

**数据后果七问**

1. Internal incorrect state：B 端以 stale 快照作为"最新"提交
2. User-visible：A 看到自己刚保存的修改消失，双方均无冲突提示
3. Server-persisted：**是——服务端内容被错误地回退到 stale 值并持久化**
4. Silent：**是**
5. 可察觉/恢复：只有人工比对历史才能发现；内容本身**不可自动恢复**
6. 覆盖他人数据：**是**（跨用户覆盖）
7. UI 还是 DB：**数据库真实错误**（SERVER_STATE）

**阶段 2 比对**：第一遍影响（"乐观锁被客户端自动绕过；B 的旧字段可能覆盖 A 的新值，且没有冲突提示或合并过程"）**完全准确**（本轮用端到端复现把"可能"升级为"实证"）；第一遍的修复方向（保留双方版本/字段级合并或用户确认）与验收（A 改 X、B 改 Y 均应保留；同改 X 必须呈现冲突）不破坏升级路径；未漏保护机制（`PROTECTED_FIELDS` 自愈只覆盖空值场景，不构成保护）。

**Severity：P1 保持**——跨用户静默持久化覆盖（INTEGRITY），修复需客户端合并语义，不能仅靠服务端。

---

## AUD-025 · 内部油脂统计把任意非"不合格"颜色当作合格

**Original claim**：油脂结果含未识别的非空 colorLevel（例如 foo）且 result 为不合格时，内部统计优先用 `colorLevel NOT LIKE '%不合格%'` 判为合格。

**Validity：CONFIRMED**（语义等价复现 + 写入路径可达性核查）

**判定域（全部允许状态）**

| colorLevel | result | 内部统计判定 | 业务裁定是否合理 |
|---|---|---|---|
| 合格 | 任意 | 合格 | ✓ 有意（与 `Dashboard.isOilQualified` 同款裁定） |
| 警戒 | 任意 | 合格 | ✓ 有意（"仅不合格为不合格"业务规则，`Dashboard.js:948-954`） |
| 不合格 | 任意 | 不合格 | ✓ |
| 空 | 合格/不含不合格 | 合格 | ✓ 回退 result 规则 |
| 空 | 不合格 | 不合格 | ✓ |
| **未知值（如 foo）** | 不合格 | **合格（fail-open）** | ✗ 缺陷 |

**SQL 语义**（`recordRoutes.js:177-184`；guest 同款 `guestRoutes.js:221-226`）：
`CASE WHEN COALESCE(colorLevel,'') <> '' THEN colorLevel NOT LIKE '%不合格%' ELSE result 规则 END`

**探针证据**：`passBySql('foo','不合格') === true`（计入合格）、`'不合格' → false`、`'警戒' → true`。

**非法值可达性（用户特别要求核查）**

- `validateRecordPayload`（`recordNormalize.js:349-362`）**不校验 colorLevel**（仅三个上下文键 + 类型）
- 所有写入路径（POST / PUT / bulk-upsert / sync）均无枚举校验；前端为受限控件（`GenericTest.js:753` radio/select）→ **UI 路径受限，API 直调/导入/历史数据可写入未知值**
- 与 OpenAPI 的一致性：`openApiScope.js` 对 colorLevel 走**显式枚举**（未知 → `unknown`，不计合格）→ **内部统计与对外口径不一致**（第一遍已指出）

**数据后果七问**

1. Internal incorrect state：统计分子把未知值计为合格
2. User-visible：看板/报告的合格率偏高
3. Server-persisted：**无**（DB 数据未变；统计为读时计算）
4. Silent：是
5. 可察觉/恢复：难以察觉；修复判定逻辑后重算即可恢复
6. 覆盖/泄露他人数据：否
7. UI 还是 DB：**UI/输出层**（DB 无错误数据）

**阶段 2 比对**：第一遍影响（"记录可能在内部/访客统计中计为合格，和明细及 OpenAPI 显式颜色映射不一致，影响检测报告可信度"）**准确且用词克制（"可能"）**；本轮确认非法值需要非 UI 路径（RARE_PRECONDITION），第一遍未夸大；未漏保护机制。

**Severity：建议 P2（降级，争议）**——影响是统计口径（不产生持久化错误、可重算恢复），且需要绕过 UI 写入未知值；若业务认为"合格率口径失真"等同于合规风险，P1 亦可辩护 → 列入仲裁。修复方向（统一结论归一函数、未知值不推定合格）不破坏升级路径，但需与 OpenAPI/前端三方同改（依赖见文末）。

---

## AUD-027 · 删除无检测记录用户会级联删除其审计历史

**Original claim**：用户没有阻止删除的 TestRecord，但有登录、用户管理等 AuditLog；User 删除触发 `onDelete: Cascade`。

**Validity：CONFIRMED**（静态链路完整：schema + 删除路径 + 替代日志边界）

**完整链路**

1. `schema.prisma` `AuditLog.user User @relation(fields:[user_id], references:[id], onDelete: Cascade)`，`user_id String`（非空）
2. `UserManager.deleteUser`：`testRecord.count({ where:{ created_by: userId } })` → `>0` 则拒绝（`:940-946`）→ `assertNotLastActiveManager` → `prisma.user.delete()`（**触发 AuditLog 级联删除**）→ 之后以 **actor** 身份 `logAdminAction('user_delete', ...)`（保留"谁删了谁"）→ `revokeUserSessions`
3. **替代日志边界**：`public.SystemLog`（`schema.prisma:346-355`）**无 User 外键**，登录失败/安全事件（如 REVOCATION_WRITE_FAILED）不受影响；租户 `AuditLog` 是被删主体维度记录的**唯一**存储

**探针证据（静态断言）**：Cascade 存在、user_id 非空、SystemLog 无 User 关联、deleteUser 前置 TestRecord 检查 + actor 留痕。

**数据后果七问**

1. Internal incorrect state：被删用户的审计轨迹（登录/用户管理/导出等）随主体物理消失
2. User-visible：审计页面查不到该用户历史
3. Server-persisted：**是（AuditLog 行物理删除）**
4. Silent：是（删除确认中不提示"将同时删除 N 条审计记录"）
5. 可察觉/恢复：不可恢复（除非整库备份）；SystemLog 仅覆盖安全事件子集
6. 覆盖/泄露他人数据：否（限定被删主体；删除动作本身留痕）
7. UI 还是 DB：**数据库真实删除**（AUDIT_INTEGRITY）

**阶段 2 比对**：第一遍影响（"审计历史随主体物理删除，违反仓库约定的审计保留目标，破坏事后追溯"）**准确**，未出现"所有审计消失"的夸大（明确限定随主体）；修复方向（软删除或审计主体快照、去掉级联）与验收合理；未漏保护机制（本轮额外确认 SystemLog 不受影响、TestRecord 前置检查、actor 留痕——这三项缩小但不推翻结论）。

**Severity：P1 保持（争议）**——审计不可恢复丢失（合规属性），但需满足"无检测记录 + 非最后 manager + 管理员操作"三个前提；若业务将 AuditLog 视为可随主体清理的运营日志，可降 P2 → 列入仲裁。

---

## 阶段 2 总比对结论

| 检查项 | 结论 |
|---|---|
| 第一遍遗漏 guard | **未发现**（本轮额外核查 CSP/导出转义/SystemLog/PROTECTED_FIELDS/前端受限控件/total 返回，均为"缩小但不推翻"） |
| mock 与生产差异 | 探针的替身仅限：认证 token（AUD-021 队列驱动）、fake fetch/HTTP server、内存 localStorage——均不影响被测的截断/状态机/冲突语义；AUD-003 使用真实渲染函数与真实 DOM |
| trigger 可达性 | 003/020/021/022/027 为 REALISTIC；025 为 RARE（需绕过 UI 输入未知 colorLevel） |
| impact 夸大 | 无（003 未声称 RCE；025 用"可能"；027 限定"随主体"） |
| duplicated root cause | 见下（021+022 同源；003 与 020 的输出/读取面各自独立） |

### root causes（4 组）

1. **输出编码缺失**（AUD-003）：内联 `innerHTML` 拼接 + 多份未统一的 escape 实现 + 页面级 CSP 缺失；后端只做键名净化。
2. **客户端本地先行状态机与版本协调缺失**（AUD-021 + AUD-022，同一 `Storage`/`AdaptiveUploadQueue` 双轨）：临时 ID 生命周期无显式状态机（编辑合并只针对"仍在队列的 create"）、409 只更新 version 而无合并语义 → 一端表现为"静默丢失编辑"，另一端表现为"静默覆盖他人"。
3. **读取链路无分页契约**（AUD-020）：一次性 `limit` 拉取 + 忽略 `total`，缓存语义被当作全量。
4. **结论归一与审计生命周期缺单一事实源**（AUD-025 + AUD-027）：合格判定分散在 4 处（内部统计 SQL / 访客统计 SQL / OpenAPI 枚举 / 前端 Dashboard）且默认 fail-open；审计主体与 User 强绑定且 Cascade 删除。

---

## 1. 三项统计

```
CONFIRMED: 6
PARTIALLY_CONFIRMED: 0
FALSE_POSITIVE: 0
NOT_REPRODUCIBLE: 0
NEEDS_RUNTIME_VERIFICATION: 0
```
（severity 降级建议 1 项：AUD-025 → P2）

## 2. 实际导致服务器持久化错误数据的问题

- **AUD-022（唯一确证的"服务端错误内容"）**：fake server 端到端复现显示 A 的更新被 stale 覆盖并持久化，且双方无提示。
- **AUD-027**：服务端审计行被物理删除（AUDIT_INTEGRITY，不可恢复）。
- **AUD-003**：恶意 payload 持久化于 TestRecord，等待他人渲染触发（服务器存储的是危险内容，但缺陷在输出编码；脚本执行未演示）。
- **AUD-021**：服务端**缺失**用户以为已保存的编辑（数据丢失型，非错误数据）。

## 3. 仅 UI / local state 的问题

- **AUD-020**：DB 完整（后端 `total` 正确返回），丢失发生在本地缓存与导出读取。
- **AUD-025**：DB 数据未变，错误在统计口径输出（内部统计 vs OpenAPI 不一致）。

## 4. silent data loss 风险

全部 6 项均为 Silent。按"损失不可恢复"排序：**AUD-022 覆盖（不可恢复）> AUD-027 审计删除（需备份）> AUD-021 编辑丢失（需重做）> AUD-020 导出缺数（可重新查询）> AUD-025 统计失真（可重算）> AUD-003 注入（字段可清理，脚本执行后果不可逆）**。

## 5. severity 争议

- **AUD-025**：P1（合规口径可信度）vs P2（需绕过 UI、可重算恢复）→ 本轮建议 P2。
- **AUD-027**：P1（审计合规不可恢复）vs P2（前置条件多、仅限主体维度）→ 本轮倾向保持 P1，交仲裁。
- **AUD-003**：P1 保持，但需在工单中明确"DOM 注入已证、脚本执行未演示"，避免下游误读为已证实 RCE。

## 6. 需要 Astra 最终仲裁的问题

1. AUD-025 终级与归一函数归属（是否引入唯一 `normalizeConclusion()` 供内部统计/OpenAPI/前端共用）。
2. AUD-027 审计保留策略：软删除 vs 审计主体快照 vs 去 CASCADE（涉及 schema 迁移）。
3. AUD-020 修复路径：服务端分页透传 total + 前端增量拉取 vs 导出端流式分页 vs 超限明确拒绝（验收口径需业务确认"报告完整性"声明）。
4. AUD-003 修复范围与回归成本：全模块 textContent 化 + 统一 escape helper，是否保留富文本字段的白名单净化。

## 7. remediation dependency

1. **AUD-021 + AUD-022 必须同批**：同一 `Storage`/`AdaptiveUploadQueue` 路径；若只修 409 合并（022）而不修临时 ID 状态机（021），编辑仍会在 create 出队后丢失；反之亦然。
2. **AUD-003 与 AUD-020 无依赖**，可并行；003 的"统一 escape helper"应先于各模块单独修补，避免 7 处 escapeHtml 分叉继续扩大。
3. **AUD-025 与 AUD-003 存在弱耦合**：若 003 采用"统一输出编码 + 白名单净化"，需同时复核 025 的结论归一（两者都涉及"同一数据在不同出口的表示一致性"）。
4. **AUD-027 依赖 AUD-008 的 migration 纪律**（本仓库存在不可回放的 migration 链，Phase2-Batch-B 结论）：schema 变更（去 CASCADE / 加软删除）必须产出可空库回放的新 migration，否则会加剧 008。
5. AUD-020 若改为服务端分页，需与 AUD-002 的幂等/缓存键改造协调（同属读取契约变更面）。

---

## NEW_FINDINGS_CANDIDATES（不并入正式清单）

| 候选 | 描述 | 证据 | 级别 |
|---|---|---|---|
| NF-C-01 | `Pathogen.js` 详情弹窗（`:1181`）与 `GenericTest` 详情弹窗的整改日志（`:350-352`）为**独立于列表**的第二批注入点；即使修复列表渲染，详情路径仍需单独覆盖 | 本轮 SINK_SURVEY + 源码 | 中（属 AUD-003 修复范围，单列供追踪） |
| NF-C-02 | 仓库存在 **7 份以上**独立 `escapeHtml` 实现（backupManager/AuditLog/adminSchools/ui/sidebar/diskView/shared…），语义可能不一致，是 AUD-003 反复出现的结构性原因 | `grep "function escapeHtml"` 全仓 | 低（工程债，影响修复一致性） |
| NF-C-03 | `ExportService.js:353` 使用 `?limit=10000` 无任何超限告警；若后端未来上调 `MAX_RECORDS_LIMIT`，前端不会自动受益（无 total 校验），截断点将随之漂移 | 源码 + 本轮 2501 条实测 | 低（与 AUD-020 同源） |

## 附录

- `phase2/probes-batch-c.mjs`（16 项断言，全部通过；含 fake HTTP server 请求日志）
- `phase2/probe-results-batch-c.json`
- 重跑：`node docs/reviews/global-audit-20260924/phase2/probes-batch-c.mjs`
- 未执行：真实数据库、外部网络、Cypress、任何破坏性操作；应用代码与 git 状态零改动。
