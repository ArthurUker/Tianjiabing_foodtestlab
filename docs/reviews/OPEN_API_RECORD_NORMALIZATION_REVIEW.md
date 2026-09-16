# 审阅报告：记录写入规范化（stripContextCopies / buildRecordWriteData）与开放接口一致性

> 审阅对象：`result_data` 上下文三键（`testDate`/`canteen`/`inspector`）同义副本收口 + 开放接口字段契约（2026-09-16 未提交工作区改动）
> 审阅方式：只读源码/差异审阅 + 无数据库路由级复现 + 只读库取证（**不修改任何文件、不写库、不重启、不提交**）
> 报告落点：`docs/reviews/`（本次新建目录；仓库既有约定见 `docs/PROJECT_CONVENTIONS.md:6`：近期变更→`docs/CHANGELOG.md`，待修问题→`docs/fix/`）

---

## 0. 审阅基准

| 项目 | 结论 | 证据 |
|---|---|---|
| 分支 / HEAD | `Product_tencent_CVM` / `50ef5dc` | `git rev-parse`，最近提交 `50ef5dc`（开放接口第二轮）、`28bd339`（开放接口首轮） |
| 未提交改动 | 8 项：7 改 + 1 新目录（`backend/tests/records/`）；暂存区为空 | `git status --porcelain` / `git diff --stat` |
| 适用规范 | 无 `AGENTS.md`；适用 `docs/PROJECT_CONVENTIONS.md` | 根目录 `ls AGENTS.md` → 不存在 |
| 部署一致性 | ✅ 已核验：`ExecStart=/usr/local/bin/node server.js`，`WorkingDirectory=/opt/foodsentinel/backend`，服务启动 `10:44:29` **晚于**全部改动文件 mtime（`recordNormalize.js` 10:30:17 / `syncRoutes.js` 10:30:33 / `recordRoutes.js` 10:30:44 / `openApiFieldSchema.js` 10:42:57） | `systemctl show` + `ls -l --time-style` |
| 前端部署 | 本轮未改前端；`dist/` 最后构建 `2026-09-15 23:26`，与服务无关 | `ls -l dist/js/.../openApiView.js` |
| 本轮动作边界 | 未修改任何源代码/数据；仅新增本报告；只读 SQL 4 次；无库复现脚本 1 个（`/tmp/review_repro.mjs`，零 HTTP、零 DB 连接） | 见第 4 节与方法说明 |

**未核验项（明确声明）**：移动端 App 源码不在本仓库；本轮无隔离数据库，未做 DB 写路径集成验证；未做线上端到端（本轮不允许）。

---

## 1. 结论摘要

1. **存在会阻塞"下一次与 App 联调/发布"的问题（1 项，由本次收口引入）**：`/api/sync/records|batch` 的 **update** 分支在客户端只提交 `result_data`（其中含上下文三键）时，会**静默丢弃**这三键（不回填 `sample_info`）。改动前这三键会保留在 `result_data` 中并在读路径生效，因此属**行为变更导致的静默丢值**。见 **H1**（已用无库复现证实）。
2. **"已覆盖全部写入路径"这一结论不成立**：`PUT /api/test-records/:id`（`recordRoutes.js:700-742`）仍原样写入 `result_data`，副本可由此回流；且该路由无版本校验。叠加读路径展开顺序（`result_data` 覆盖 `sample_info`），可造成"前端/导出 = 新值，开放接口/统计 = 旧值"的三口径分叉。见 **H3 / M1**（已证实）。
3. **两个既有高危写入缺陷（非本次引入，但同属该数据面）**：`result_data: {}` 会让整条记录（含 `sample_info`）变空（**H2**）；sync 写入的 `status` 无白名单（**M5**）。均已复现。
4. **字段字典不是完整契约**：实测有 `oil.result`（39/39）、`pathogen.sampleId`/`sampleType`（66/66）未登记，且 `result.sampleInfo`（66/66）不仅未登记、其 jsonb 类型是 **string（双重编码）**。投影是**黑名单**策略，新增字段默认外发。见 **M2**（只读库实测）。
5. **同步契约缺一条**：记录级字段减少不会改变 `projection_fingerprint`，接入包只写了"授权导致字段撤回"要重投影，客户端按字段级 merge 会残留旧副本。见 **M3**。
6. **已核验正确的部分**（第 3 节）：records 三入口 + sync add/update 的收口真实生效；`record_code` 幂等键不受影响；Web 前端（本仓库内唯一可核验客户端）载荷为扁平结构，**不受本次收口影响**；服务运行的正是当前工作区代码；回滚旧代码读新记录兼容。

> 不下"绝不会出问题"的结论：H1/H2/H3/M5 的**触发都依赖客户端载荷形态**，而 App 源码不在仓库，故其真实影响面标为"待验证"，仅代码路径层面为"已证实"。

---

## 2. 数据流重建

### 2.1 写入路径总表（含本轮收口覆盖情况）

| 入口 | 认证/租户 | 入参形态 | 规范化 | 幂等 | 写库 | 收口状态 |
|---|---|---|---|---|---|---|
| `POST /api/records/:tableName`（Web 主路径） | JWT + `requireEditorOrAbove`；`req.db` | **扁平**（客户端 `_sanitizePayload` 剔服务端字段） | `buildRecordWriteData` (`recordRoutes.js:287`) | 前置 `record_code` 查重 + P2002 回查 | `create` (:303) | ✅ 覆盖 |
| `PUT /api/records/:tableName/:id` | 同上 | 扁平（缺三键→400，见复现 R2） | `buildRecordWriteData` (:493) + 复检自愈 (:496-506) + 字段保护 (:518-528) | `where{id,version}` 原子锁 (:543) | `update` (:542) | ✅ 覆盖 |
| `POST /api/records/:tableName/bulk-upsert` | 同上 | `{records:[…]}` | `buildRecordWriteData` (:375) | code 去重 + 归属校验 + `expected_updated_at` | `update`/`create` (:405/:414) | ✅ 覆盖 |
| `POST /api/sync/records` add | JWT + `requireEditorOrAbove`；`req.db` | `{action,store,data}`（App 路径） | `stripContextCopies` (`syncRoutes.js:49`) | P2002 按 `record_code` 回查 (:120) | `create` (:50) | ✅ 覆盖 |
| `POST /api/sync/records` update | 同上 | 同上 | `stripContextCopies` (:78) | 无版本校验（仅归属校验 :71） | `update` (:83-85) | ⚠️ 覆盖但**丢值**（H1） |
| `POST /api/sync/batch` add/update | 同上 | `operations[]` | `stripContextCopies` (:155/:178) | 逐 op P2002 回查 (:207) | `create`/`update` (:156/:183) | 同上 |
| `POST /api/test-records`（legacy 直写） | 同上 | `{test_type,test_name,sample_info,result_data}` | `stripContextCopies` (`recordRoutes.js:46`) | `record_code` 查重 | `create` (:47) | ✅ 覆盖（本路由原先既不填 `sample_info` 也不剥离） |
| **`PUT /api/test-records/:id`** | 同上 | `{test_name,status,result_data}` | **仅 `sanitizeObjectKeys`** (:725) | **无版本校验** | `update` (:728) | ❌ **未收口（H3）** |
| `DELETE /api/test-records/:id`、`DELETE /api/records/:tableName/:id` | 同上 | id | — | 归属校验 | 硬删除 | — |
| `DELETE /api/sync/queue` | JWT + `authorizeAdmin` | — | — | — | `deleteMany({status:'archived'})` (:263) | 与 M5 组合有风险 |
| 导入脚本 `import-{tjb,zhyz}-backup.mjs` / `import-tjb-sqlite.mjs` / `import-backup-local.mjs` / `scripts/import-backup.mjs` | 无 HTTP 认证；`$executeRawUnsafe`/基础 prisma；schema 硬编码 | 旧备份 JSON / manifest | 无（自建 JSON，tjb/zhyz 脚本**仍注入三键副本**） | 写前 `record_code` 查重 | INSERT/UPDATE | ❌ 未覆盖（M6，见 §6 结论） |
| `fix-canteen-from-location.mjs` | 无；**基础 prisma（→ public）** | — | 无（只改 `sample_info`） | `--fix` 开关 | `update` | ❌ 未覆盖（M1/M6） |
| `restoreService`（备份恢复） | 超管路由 + psql | 整 schema | 无（整段覆盖 + 影子 schema 原子切换） | 行数校验 | `ALTER SCHEMA RENAME` | 不适用（结构级） |

**无 TestRecord 写入的路径（已核对，避免"按 URL 数路径"）**：`TestItem`/`Attachment` 全仓库无写调用点；`backupService`/`tenantSync`/`tenantProvisioner`/`seed`/`securityAlerts`/`authMiddleware` 定时器均不写 TestRecord。

### 2.2 消费方（读路径）

| 消费方 | 字段来源 | 证据 |
|---|---|---|
| Web 前端（录入/列表/详情/看板/导出） | 后端 `buildRecordPayload` 展开后的**顶层扁平字段**（`canteen`/`testDate`/`inspector`） | `recordNormalize.js:26-47`；前端 `Dashboard.js getRecordCanteen`、`Tableware.js`、`ExportService.js` 均读顶层 |
| Web 客户端提交形态 | **扁平对象**（仅剔 `record_code/test_type/test_name/created_at/updated_at/completed_at/_status`） | `core/Storage.js:793-797`、`:423-450`；URL 构造 `AdaptiveUploadQueue.js:219-232` |
| 员工端统计 `/api/test-records/stats` | SQL 取 `sample_info->>'testDate'/'canteen'` + `result_data->>'result/colorLevel/riskLevel'` | `recordRoutes.js:165-198` |
| 开放接口明细/清单/统计 | 顶层 `test_date/canteen/inspector` ← **`sample_info`**；业务字段 ← `result_data` 经 `projectResultData` | `openApiScope.js:208-239`、`openApiRoutes.js:378-386/515-524` |
| 开放接口字典/样例 | `listFieldDescriptors` + `SchoolCustomization` 自定义字段；样例走同一投影 | `openApiFieldSchema.js:127-148`、`openApiRoutes.js:216-224/268-281` |
| 超管预览/接入包 | 同源 `buildOpenRecord` / 同源 descriptors | `adminOpenApiRoutes.js:391-405/503-640` |

---

## 3. 问题清单（按严重程度）

> 每条含：严重程度｜文件行号｜触发条件与入口｜最小复现｜预期 vs 实际｜影响｜状态｜最小修复｜应补回归。
> 复现脚本与捕获输出见**附录 A**；库内取证见**附录 B**。

### H1（高｜由本次收口引入）sync update 静默丢弃 `result_data` 内的上下文三键

- **文件行号**：`backend/routes/syncRoutes.js:76-84`（单条）、`:178-184`（批量）；剥离逻辑 `backend/lib/recordNormalize.js:65-75`
- **触发条件/入口**：`POST /api/sync/records` 或 `/api/sync/batch`，`action=update`，请求体**只**含 `data.result_data`（其中带 `canteen`/`testDate`/`inspector`），不含 `data.sample_info`
- **最小复现**（附录 A / R-U1）：`{action:'update',store:'oil',data:{id:'r1',result_data:{canteen:'RD新食堂',tpmValue:'0.9'}}}`
- **预期**：改动前三键随 `result_data` 落库（读路径因 `...resultData` 覆盖而显示新值）
- **实际**：写入 `{result_data:{tpmValue:'0.9'}}` —— 三键被删除，且 `sample_info` 未写（`hasUpdateSI=false` → `undefined`），**用户改的食堂被静默丢弃**（无 400、无提示）
- **影响**：数据丢失（用户主动修改丢失）；且无任何日志可追溯
- **状态**：**已证实**（无库路由级复现，零 DB 写入）
- **最小修复**：`hasUpdateRD && !hasUpdateSI` 时，把被剥离的三键以 `existing.sample_info` 为基底合并后写回 `sample_info`（同分支已在 `:67`/`:191` 读取 `existing`，无需额外查询）；若不愿隐式改写，则**显式 400** 提示"上下文字段请提交到顶层"——两者都比静默丢弃好
- **应补回归**：update 传 `result_data` 含 `canteen` 且库中 `sample_info.canteen=旧值` → 断言 `sample_info.canteen=新值`、`result_data` 无副本、读路径返回新值

### H2（高｜既有，未被本次收口触及）`result_data: {}` 使整条记录内容变空

- **文件行号**：`syncRoutes.js:49`、`:155`（`data.result_data || data`）；对照：records 路由有 `validateRecordPayload`（`recordRoutes.js:282`、`:485`），**sync 路由全程无校验**
- **触发条件**：`data = { result_data: {}, testDate:'2026-03-01', canteen:'A食堂', inspector:'张三', tpmValue:'0.1' }`
- **最小复现**（附录 A / R-A3）：捕获到的写库实参 `create.data = { sample_info:{}, result_data:{}, status:'completed', … }`
- **预期**：`{}` 视为"未提供 result_data"，回退到扁平对象
- **实际**：`{}` 是 truthy → 走 `result_data` 分支；回填源也是 `{}` → **业务字段与三键全部丢失**，写出一条空记录（HTTP 200）
- **影响**：静默数据丢失 + 脏记录进入看板/统计/开放接口
- **状态**：**已证实**（代码层面；触发依赖客户端形态，App 侧待验证）
- **最小修复**：`const hasRD = data.result_data && typeof data.result_data==='object' && Object.keys(data.result_data).length>0`；并对 sync add 应用 `validateRecordPayload`（至少校验三键非空）
- **应补回归**：`result_data` 缺失 / `null` / `{}` 三形态都必须保留业务字段

### H3（高｜既有；使"全部写入路径已覆盖"不成立）`PUT /api/test-records/:id` 未收口 + 无版本校验 → 副本回流与口径分叉

- **文件行号**：`recordRoutes.js:724-726`（只 `sanitizeObjectKeys(result_data)`）、`:728-731`（`update` 无 `version`/`where` 版本条件）；配套：`GET /api/test-records/:id`（`:653-689`）**不展开**、原样返回嵌套 `sample_info`/`result_data`
- **触发条件/入口**：任何具备编辑权限的客户端 `PUT /api/test-records/:id`，body 的 `result_data` 含上下文三键（**把该 GET 的返回原样回传即可命中**）
- **最小复现**（附录 A / R-T1）：捕获到 `update.data = { result_data: { canteen:'新食堂RD', testDate:'2026-04-01', inspector:'王五', tpmValue:'0.3' } }` —— 副本原样入库存活
- **预期**：与其它写入路径一致（三键只落 `sample_info`，或显式拒绝）
- **实际**：副本写回 `result_data`；因该路由不写 `sample_info`，与既有 `sample_info` 形成分叉 → 读路径分叉见 **M1**（附录 A / R-DIV：内部扁平读 canteen=RD 新值，开放接口 canteen=SI 旧值）
- **影响**：①契约矛盾（文档/字典称"新记录不再产生副本"）；②同一记录在"前端/导出"与"开放接口/统计"下显示不同食堂/日期/检测人；③无乐观锁，可覆盖他人在此期间的修改（归属校验仍生效，非越权）
- **状态**：**已证实**（无库路由级复现 + 纯函数读路径对照）
- **最小修复**：该路由改为 `stripContextCopies(result_data, existing.sample_info)` 并把结果同时写回 `sample_info`；补 `version` 校验或明确标注为"内部维护端点"并从公开 API 文档移除
- **应补回归**：PUT 后断言 `result_data` 无副本、`sample_info` 已更新、两端口径一致

### M1（中｜既有）读路径展开顺序让 `result_data` 覆盖 `sample_info`，与"以顶层为准"契约相反

- **文件行号**：`recordNormalize.js:35-37`（`...sampleInfo, ...resultData`）
- **触发条件**：任何 `sample_info` 与 `result_data` 内副本不一致的记录（由 H3 或人工 SQL/修复脚本制造）
- **最小复现**（附录 A / R-DIV，纯函数）：构造分叉记录 → 内部扁平读 `canteen=新食堂(RD)`、`testDate=2026-04-01`；开放接口 `canteen=旧食堂(SI)`、`test_date=2026-03-01`
- **预期**：三键一律以 `sample_info`（= 对外顶层）为准
- **实际**：内部读被 `result_data` 副本覆盖；对外的开放接口与 `stats` 取 `sample_info` → 两套读数
- **影响**：`sample_info`-only 的修复（如 `fix-canteen-from-location.mjs`）在前端/导出**不可见**；把 H3 从潜在变成可达
- **状态**：**已证实**
- **最小修复**：交换展开顺序（`{...resultData, ...sampleInfo, ...server}`）——注意需回归前端 ~30 处调用点与 `_normalizeRecord` 的缓存迁移分支；或最小改动：在 `buildRecordPayload` 中显式用 `sample_info` 覆盖三键
- **应补回归**：构造分叉记录，断言扁平读三键 = `sample_info` 值

### M2（中）字段字典未覆盖真实下发字段；未知字段策略为黑名单（新增字段默认外发）

- **文件行号**：`openApiFieldSchema.js:127-148`（按类型固定清单 + 自定义字段）、`openApiScope.js:64-77`（递归**黑名单**剔除）
- **只读实测证据**（附录 B，`school_tjb`）：

  | 实测键 | 出现 | 字典是否登记 | 备注 |
  |---|---|---|---|
  | `result.result` | oil **39/39**、tableware 233/234、leanMeat 494/494、pesticide 296/296 | oil **未登记**（其余登记） | oil 的 `/stats` 口径在 `colorLevel` 为空时**回退读 `result`**，第三方按字典实现会漏此字段 |
  | `result.sampleId`、`result.sampleType` | pathogen **66/66** | **未登记** | 会原样下发 |
  | `result.sampleInfo` | pathogen **66/66** | **未登记**，且 `jsonb_typeof = 'string'` | **双重编码 JSON 字符串**，客户端拿不到对象 |
  | `result.testType` | tableware 61/234 等 | 仅 tableware 登记 | 其它类型未登记 |
  | `result.traceabilityRecords` | tjb 4 | 已剔除（内部键） | ✅ 正常 |

- **预期**：字典路径集合 ⊇ 实际下发字段集合；且"未登记字段不得下发"
- **实际**：黑名单策略下，未登记字段照样下发；字典缺口 3+ 处；`sampleInfo` 还是字符串形态
- **影响**：第三方按字典开发必然漏字段/踩类型；未来新增字段（含人名类以外的敏感键）默认外泄；双重编码字段无法直接解析
- **状态**：**已证实**（只读库实测 + 代码）
- **最小修复**：①字典补齐上述路径（`sampleInfo` 标注 `type: string` + 双重编码说明）；②排查双重编码来源（`import-backup-local.mjs:104-105`、`fix-canteen-from-location.mjs:110` 把 `JSON.stringify` 传给 Prisma Json 列）并评估清洗；③中期改 per-type 白名单投影（"未登记即不下发"）
- **应补回归**：只读审计断言 `字典路径 ⊇ 实测键集合`（可脚本化，零风险）

### M3（中）同步契约未覆盖"记录级字段减少"

- **文件行号**：`adminOpenApiRoutes.js:603-604`（接入包规则 8 只描述**授权**导致的字段撤回）、`openApiScope.js:282-292`（`projection_fingerprint` 只由 grant 维度决定）
- **触发条件**：收口生效后，历史记录被再次保存（Web/App 编辑、复检）→ `result_data` 中的 `canteen`/`testDate` 副本消失，但 `projection_fingerprint` 与 `scope_version` **都不变**
- **最小复现**：静态论证 + 附录 A 的 R-U1/R-T1 形态；客户端若按字段级 merge（文档只要求"指纹变化时整体替换"）→ 本地保留已不存在的 `result.canteen`
- **预期**：契约明确"`result.*` 字段可能减少，必须按 `record_code` 整体替换"
- **实际**：文档只在 `projection_fingerprint` 变化时要求重投影，记录级减少无规则覆盖
- **影响**：第三方本地数据与源端长期不一致（脏字段残留），对账时按字段比对会失败
- **状态**：**已证实（机制层面）**
- **最小修复**：接入包补一条规则 + 明确"`updated_at` 变化时按整体替换处理"；`docs/examples/openapi-sync-client.mjs` 增加"记录级字段减少"场景
- **应补回归**：同步客户端示例新增该场景并断言本地不残留

### M4（中低）`emitted:false` 在机器可读契约中不可见

- **文件行号**：`adminOpenApiRoutes.js:572-574`（接入包字段表只有 路径/中文名/类型/单位/必现/可空/说明）、`openApiRoutes.js:236-242`（notes 有文字说明）
- **触发条件**：第三方或用例按字段表机器解析 `result.inspector`
- **预期**：明确不下发
- **实际**：表中显示"必现=否、可空=是"，`emitted:false` 只在长文本描述里
- **影响**：第三方可能实现一个永不出现的字段分支；联调期产生"是不是开关没生效"的误判
- **状态**：**已证实**（渲染代码）
- **最小修复**：接入包字段表增加「下发」列（`emitted===false ? 否 : 是`）；`/v1/dict` 顶层加 `not_emitted: [paths]` 汇总
- **应补回归**：断言接入包对 `emitted:false` 行显式可见

### M5（中）sync 写入的客户端可控字段：`status` 无白名单、`record_code` 可指定

- **文件行号**：`syncRoutes.js:52`（`record_code: data.record_code || SYNC-…Date.now()`）、`:57`（`status: data.status || 'completed'`）、`:120`（P2002 按 `record_code` 回查并回显）、`:263`（物理删除 `status='archived'`）
- **最小复现**（附录 A / R-A7）：客户端传 `record_code:'RC-自定义'`、`status:'archived'` → 写库实参 `status:'archived'` 生效
- **预期**：`status` 受白名单约束（对照 `recordRoutes.js:716-723`）；`record_code` 复用他人码时不得回显他人记录
- **实际**：任意字符串可作 status；`record_code` 冲突时返回既有记录（`idempotent:true`），客户端会认为"已保存"，实际其数据被丢弃（同租户内、可能非本人记录）
- **影响**：①客户端可把记录置为 `archived`，与 admin 的"清空已归档"（`/api/sync/queue`，需 admin）组合会**物理删除**；②静默丢弃 + 他人记录字段回显
- **状态**：**已证实**（复现；App 权限发放策略未知 → 影响面待验证）
- **最小修复**：status 白名单（`pending/completed/failed`）；P2002 回显仅在 `created_by` 匹配时返回记录，否则 409 并提示记录码冲突
- **应补回归**：非法 status → 400；他人记录码 → 409

### M6（中低）导入/修复脚本的遗留与运维风险（与"脚本已运行过、无需修改"的结论不完全一致）

- **证据**：
  - `backend/scripts/import-tjb-backup.mjs:71-72`、`import-zhyz-backup.mjs:67-68` 仍**主动把三键写入 `result_data`**，注释写"与系统写入一致"——与 `README.md:539` 的新口径**相反**（措辞矛盾）
  - 两者**默认直接写库**（需显式 `--dry-run` 才预览），而 `import-tjb-sqlite.mjs` 默认 dry-run（`:46,141-145`）
  - `import-backup-local.mjs:104-105`、`fix-canteen-from-location.mjs:110` 把 `JSON.stringify(...)` 传给 Prisma `Json` 列（与 M2 的 `sampleInfo` 字符串同源：双重编码）
  - `fix-canteen-from-location.mjs:46-62,108` 用**基础 prisma 单例**（→ `public`）配 `school_code` 过滤，而租户数据在 `school_<name>` → 生产上几乎不命中；且只改 `sample_info` → 与 M1 组合后前端仍看不到修复
- **对第 6 节 7 问的回答**：
  1. **是否仍被文档/部署/恢复流程引用**：❌ 否。全仓库仅 `backend/scripts/README.md:23` 提到 `import-backup-local.mjs` 的命名沿革，`docs/TASKS.md:174` 泛称 `import-*.mjs`；`docs/deployment/backup-module.md` 引用的是 `003_backup-now.mjs`/`004_backup-verify.mjs`（另一支）→ 结论"已执行完、无运维引用"**成立**
  2. **可重复执行**：✅ 各自有 `record_code` 查重；增量语义无（全量扫描源文件）
  3. **哈希基于什么**：tjb/zhyz 脚本用**原始行 JSON** 截断 sha256（`:77`/`:72`），与平台 `buildRecordHash`（剥 volatile + 键排序，`recordNormalize.js:222-232`）**不同源** → 不参与平台幂等，只服务脚本自身查重
  4. **仍写副本的影响**：**仅冗余**。副本与 `sample_info` 同值，不改变读取优先级（除 M1 的极端分叉），不改变 `record_code`，不影响增量（`digest` 基于 `record_code@updated_at`）→ **无功能影响，但有契约噪音**
  5. **新规范化逻辑处理导入记录会否二次变化**：不会自动变化；仅当该记录被再次编辑时副本被剥离（此时 `updated_at` 变化，第三方会重取该条）→ 与 M3 同源启示
  6. **恢复旧备份后新读写路径是否兼容**：✅ 兼容（读路径对老记录照旧展开三键；写路径会剥离副本）
  7. **回滚旧版本后能否读新记录**：✅ 能。旧版 `buildRecordPayload` = `{...sample_info, ...result_data}`，三键由 `sample_info` 提供；旧版开放接口投影同样取 `sample_info`（`openApiScope.js:208-239` 逻辑自首轮上线未变）→ **无需数据回滚**
- **状态**：**已证实（静态）**；脚本对库的实际影响未运行验证（本轮禁写）
- **最小修复**：更新这两处注释与 README 口径；给默认写库脚本加 `--dry-run` 默认或二次确认；修复 `JSON.stringify` 双重编码；`fix-canteen-from-location.mjs` 改用 `createTenantClient`
- **应补回归**：脚本级 dry-run 快照测试（不连库）

### L1（低）注释与实现不一致
`syncRoutes.js:263` 附近注释写"清空 **completed** 状态"，实际 `where: { status: 'archived' }`（`:264`）。建议改注释。

### L2（低）`result_data: null` 会把字面键写入并下发
复现 R-A4：`data.result_data = null` → 落库 `result_data = { result_data: null, tpmValue:'0.1' }`。黑名单不拦 `result_data` 键 → 第三方会看到 `result.result_data: null`。修复：fallback 分支剔除 `result_data`/`sample_info` 等传输层键。

### L3（低）非对象 `sample_info` 时副本被丢
复现（附录 A / R-A8，纯函数）：`sample_info: 'oops'` → `stripContextCopies(rd, 'oops')` 返回 `sampleInfo=null` → add 分支写 `sample_info:{}`，三键丢失（改动前会由 Prisma 抛类型错误，不会静默）。修复：非对象入参按**缺失**处理并回填。

### L4（低）测试覆盖缺口
见第 4 节：无 DB、无 HTTP、无 sync 路由、无批量重试/时间戳/并发断言。

---

## 4. 已核验正确的关键行为（证据）

1. **收口在 records 三入口真实生效**：无库复现 R1 捕获 `create.data = {sample_info:{testDate,canteen,inspector}, result_data:{tpmValue}, …}`；代码位置 `recordRoutes.js:287`（create）、`:375`（bulk）、`:493`（PUT）。
2. **sync add 的剥离/回填符合设计**：R-A1/R-A2/R-A4 均得 `sample_info` 含三键、`result_data` 无三键；R-U2/U3 证明 update 只写提交过的字段（未提交 `result_data` 时不会被改写）。
3. **回填不覆盖已有值**：`recordNormalize.js:71`（仅 `undefined/null/''` 时回填）→ `stripContextCopies(rd,{canteen:'第二食堂'})` 保留"第二食堂"（records 测试第 5 项断言）。
4. **`record_code` 幂等键不受剥离影响**：`buildRecordHash` 用**入参 payload**（`recordNormalize.js:229-232`），records 测试第 7 项断言"同 payload、不同键序 → 同码"。
5. **开放接口边界正确**：顶层三键取 `sample_info`（`openApiScope.js:220-221`、`235-237`）；嵌套 `inspector`/`user` 恒剔除（PII 正则 `:39-57`）；内部键（`modificationLogs`/`traceabilityRecords`/`created_by`…）剔除（`:20-32`）。上一轮冒烟（49 项）已覆盖 `include_inspector` 开/关两态与越权错误码。
6. **部署一致性可核验**：服务启动 `10:44:29` 晚于全部改动 mtime；`HEAD=50ef5dc` 未提交未推送 → "线上 = 当前工作区"成立（**这是本轮唯一可完全核验的环境结论**）。
7. **Web 客户端兼容（B 不影响）**：载荷为扁平（`Storage.js:793-797` 只剔 6 个服务端字段）、URL 为 `/api/records/<table>[/<id>]`（`AdaptiveUploadQueue.js:219-232`）、读侧只用扁平字段 → 收口后服务端返回的扁平形态不变（三键由 `sample_info` 提供，R1 证据）→ 不会引发"响应变化→反复重传"。
8. **回滚兼容（推理+代码）**：旧代码读新记录三键来自 `sample_info`，无缺口；开放接口投影同样取 `sample_info`。
9. **导入脚本无运维引用**：见 M6-1 的穷举结果。

---

## 5. 覆盖与缺口

| 维度 | 覆盖情况 | 说明 |
|---|---|---|
| 静态审阅 | ✅ 全量 | 写入路径（含脚本/恢复/定时任务）+ 消费方 + 文档引用，均带行号 |
| 单元测试 | ✅ 23 项（`backend/tests/openapi/contract.test.mjs` 16 + `backend/tests/records/record-normalize.test.mjs` 7） | **真实调用** `stripContextCopies`/`buildRecordWriteData`/`buildRecordPayload`/`buildDeterministicRecordCode`/descriptors；**无 mock**。局限：纯函数，断言"键消失 + 其它值保留"，不覆盖 DB/路由/失败分支/并发 |
| 路由级集成 | ⚠️ 本轮新增（无 DB） | 直接调用真实 handler、桩掉 `req.db`，捕获写库实参；覆盖 11 个场景（附录 A）。**不覆盖**：Prisma 实际写入、`updated_at` 推进、唯一约束、事务 |
| 数据库行为 | ⚠️ 只读取证 | 键分布/字典覆盖度/`jsonb_typeof`（附录 B）。**未做**写路径集成（本轮无隔离库、且禁止写生产） |
| App 兼容 | ❌ 未核验 | App 源码不在仓库；H1/H2/M5 的**真实触发概率**取决于 App 载荷形态，本轮无法判定 |
| 批量/重试/时间戳/并发 | ❌ 未核验 | 涉及 DB（`expected_updated_at`、`updated_at` 水位、P2002 并发） |
| 线上端到端 | ❌ 未做（本轮不允许） | 上一轮的 7 项验证为**直接 Prisma 写入**（`buildRecordWriteData`+`createTenantClient`），**未经过 HTTP 路由/中间件**，也**未覆盖 `/api/sync/*`** |
| 修复后回归 | ❌ 待办 | 见第 6 节各批次的"应补回归" |

---

## 6. 建议修复批次（本轮不执行）

**首批（数据丢失/兼容性｜建议在下次发布前决策）**
- H1（sync update 丢值）——最小改动 2 行级；必须与 App 侧载荷形态核验同时进行
- H3（`PUT /api/test-records/:id` 收口 + 版本校验）
- H2（`{}` 视为缺省 + sync 补校验）
- M5（status 白名单；P2002 回显限本人）
- 验证要求：**需要 DB 级集成测试**——建议在隔离库（或 `school_test` 沙箱、经用户授权的 HTTP 调用）跑"旧载荷创建 → 读 → 只改一个值 → 再读 → 断言三键与业务字段"矩阵；**涉及生产操作：无**（仅代码改动 + 测试环境）

**次批（同步/契约/文档一致性）**
- M1（读路径优先级——涉及前端 ~30 处调用点，需回归）
- M2（字典补齐 + 双重编码治理评估 + 中期白名单投影）
- M3（接入包补"记录级字段减少 → 整体替换"规则 + 示例脚本新增场景）
- M4（接入包字段表加「下发」列 / `dict.not_emitted`）
- M6（脚本注释与 README 口径、默认 dry-run、`JSON.stringify` 修复、`createTenantClient`）
- 验证要求：文档改动 + 只读审计脚本；**不涉及生产操作**

**后续（不影响正确性）**
- L1（注释）、L2（fallback 剔传输层键）、L3（非对象入参兜底）、L4（补 DB/路由级回归）
- 可选：把附录 B 的只读审计固化为 `backend/tests/openapi/` 下的只读脚本，纳入例行核对

**明确不建议的批量动作**：不要为消除副本而批量清洗历史数据——对外值不变（`sample_info` 权威）、清理会推进 `updated_at` 触发全量重取（见 2026-09-16 记忆：`TestRecord` 无触发器、`updated_at` 无默认值，且内容哈希变化会影响将来重导去重）。

---

## 附录 A：无库路由级复现（脚本要点与捕获输出）

脚本：`/tmp/review_repro.mjs`（临时；核心逻辑见下）。做法：`createSyncRoutes({},{})` / `createRecordRoutes({authenticateUser:noop, requireEditorOrAbove:noop, requireGuestReadOnly:noop, idempotencyMiddleware:noop})` 构造真实路由 → 从 `router.stack` 取 handler → 以**桩 `req.db`** 调用 → 打印捕获的写库实参。**零 HTTP、零数据库连接。**

```js
function handlerOf(router, method, path) {
  for (const l of router.stack)
    if (l.route && l.route.path === path && l.route.methods[method])
      return l.route.stack[l.route.stack.length - 1].handle
}
// req.db 桩：create/update 记录实参并返回假记录；findUnique 返回预置 existing
```

| 场景 | 输入（要点） | 捕获到的写库实参 | 判定 |
|---|---|---|---|
| R-A1 纯平铺 add | `{testDate,canteen,inspector,tpmValue}` | `sample_info={三键}`，`result_data={tpmValue}` | ✅ 符合设计 |
| R-A2 `result_data` + 空 `sample_info` | `result_data={三键+tpmValue}, sample_info={}` | 同 R-A1（回填成功） | ✅ |
| **R-A3 `result_data:{}` + 平铺** | `{result_data:{}, testDate,canteen,inspector,tpmValue}` | `sample_info={}, result_data={}` | ❌ **全丢（H2）** |
| R-A4 `result_data:null` + 平铺 | 同上但 `null` | `result_data={result_data:null, tpmValue}` | ⚠️ 垃圾键入库（L2） |
| R-A5 三处冲突 | 顶层`顶层食堂` / `sample_info.canteen='SI食堂'` / `result_data.canteen='RD食堂'` | `sample_info.canteen='SI食堂'` | 顶层被丢弃；sample_info 优先 |
| R-A6 顶层 vs `result_data` | 顶层`顶层食堂` / `result_data.canteen='RD食堂'` | `sample_info.canteen='RD食堂'` | 顶层被丢弃（`result_data` 优先于顶层） |
| R-A7 控制字段注入 | `status:'archived'`、`record_code:'RC-自定义'`、`created_by:'u_other'`、`id:'rec_of_other'` | `status='archived'`、`record_code='RC-自定义'` 生效；`created_by` 仍为服务端用户；`id/created_by/status/record_code` 作为**垃圾键进入 result_data** | ⚠️ M5 + L2 |
| **R-U1 update 只传 result_data（含 canteen）** | `{id:'r1', result_data:{canteen:'RD新食堂', tpmValue:'0.9'}}` | `update.data={result_data:{tpmValue:'0.9'}}`（sample_info 未写） | ❌ **静默丢值（H1）** |
| R-U2 update 只传 sample_info | `{id:'r1', sample_info:{…}}` | `update.data={sample_info:{…}}` | ✅ 不误改 result_data |
| R-U3 update 只改状态/名称 | `{id:'r1', status:'archived', test_name:'改名'}` | `update.data={test_name, status}` | ✅ 两个 JSON 均未被改写 |
| R1 records create 扁平完整 | `{testDate,canteen,inspector,tpmValue,version:3}` | `sample_info={三键}`、`result_data={tpmValue}`、`record_code=RC-oil-<sha256>` | ✅ 主路径正确 |
| R2 records create 局部（缺 inspector） | 缺 `inspector` | 响应 `400 ❌ 字段验证失败 details=["字段 \"inspector\" 不能为空"]` | ✅ 不接受局部创建 |
| **R-T1 legacy PUT 带三键** | body=`{result_data:{canteen,testDate,inspector,tpmValue}}` | `update.data={result_data:{…含三键…}}` | ❌ **未收口（H3）** |
| R-A8（纯函数）非对象 sample_info | `stripContextCopies(rd,'oops')` | `resultData={tpmValue}`、`sampleInfo=null` → add 写 `{}` | ⚠️ L3 |
| **R-DIV 读路径分叉（纯函数）** | 合成分叉记录 | 内部扁平读 `canteen=新食堂(RD) testDate=2026-04-01`；开放接口 `canteen=旧食堂(SI) test_date=2026-03-01` | ❌ **两端口径不一致（M1+H3）** |

## 附录 B：只读库取证（`school_tjb` / 4 租户；仅键名与计数，无 PII 内容）

- 顶层键全集（tjb 32 个）：`acidValue, allTestItems, atpPoints, batchNo, canteen, colorLevel, correctiveAction, finalStatus, inspector, internalControlStatus, location, meatType, modificationLogs, oilTemp, positiveDetails, positiveItems, recheckRecords, recheckReports, recheckResult, remark, result, riskLevel, riskReason, rluValue, sampleId, sampleInfo, sampleType, testDate, testType, tpmValue, traceabilityRecords, vegetableType`
- 按类型的关键缺口：`oil.result` 39/39、`pathogen.sampleId/sampleType/sampleInfo` 66/66（且 `jsonb_typeof(sampleInfo)='string'`）、`tableware.testType` 61/234
- 嵌套容器键：`atpPoints{loc,res,rlu,testType}`；`recheckRecords{id,time,user,isPassed,points}`（`user` 由投影剔除）
- 名字类扫描：仅 `inspector`（1129）命中；无 `*Name`/`*User` 类其它键
- 自由文本规模：`remark` 非空 2 条、`riskReason` 非空 66 条（max 72 字符）→ 自由文本内是否含人名**未验证**（本轮不读内容）

---

# 第二轮：修复与验证（2026-09-16 追加，**原始发现与证据保留未改**）

> 本轮授权：修改源码、补测试、更新文档、使用隔离测试环境验证。
> **未授权且未执行**：生产库写入、历史数据清洗、迁移、构建发布、重启、提交、推送。
> 工作区所有改动保持未提交状态（HEAD 仍为 `50ef5dc`）。

## A. 审阅结论校正（先纠正，再处置）

| 项 | 原结论 | 校正后（本轮取证） |
|---|---|---|
| M2 `result.sampleInfo` | 判为"**双重编码 JSON 字符串**（根因：脚本把 JSON.stringify 传给 Json 列）" | ❌ **原判错误**。只读实测：`jsonb_typeof = string`、长度 5~16、首字符为中文 → 它是**普通字符串字段**（样品说明），**不是**双重编码。已按字符串登记进字典。`import-backup-local.mjs:104-105` / `fix-canteen-from-location.mjs:110` 的 `JSON.stringify` 写法仍是**静态观察到的历史风险**（若运行会把对象存成字符串），但**与 `result.sampleInfo` 无关**。 |
| M2 字典缺口 | 列了 oil.result / sampleId / sampleType / sampleInfo | 确认无误（数量：oil.result 39/39、pathogen 三条各 66/66），已补齐 |
| 新增发现（本轮） | — | **`extractCustomFieldMeta()` 返回值键名与 `listFieldDescriptors()` 的 ctx 不匹配**（`names/labels` vs `customFieldNames/fieldLabels`）→ **对外 `/v1/dict` 里学校自定义字段实际从未生效**。此项若不修，会与新的字段白名单叠加造成"在用自定义字段被静默丢弃"。已修复 + 回归用例。 |
| 部署一致性 | "线上版本未核验" | 证据链补强：①无构建/转译步骤（`ExecStart=node server.js`，工作目录 `/opt/foodsentinel/backend`）；②进程启动 `2026-09-16 10:44:29` **晚于**当时全部改动文件 mtime（10:30:17~10:42:57）。⇒ 运行的就是当时的工作区代码。**但**：`/health` 只返回 `{status,timestamp}`，**无版本/指纹标识**，无法从外部独立证明代码身份；且本轮修复**未部署**（见 E 节）。 |

## B. 处置清单

| 编号 | 处置 | 关键改动 | 验证 |
|---|---|---|---|
| **H1** sync update 丢值 | ✅ **已修复** | `routes/syncRoutes.js`（单条/批量 update 分支改用 `normalizeWriteJson`，把 `result_data` 内的三键合并写回 `sample_info`） | 路由级用例（含 `existing` 旧值场景）+ **隔离库链路1/2** |
| **H2** `result_data:{}` 写空记录 | ✅ **已修复** | `lib/recordNormalize.js`：`{}`/`null` 视为"未提供"→ create 回退扁平载荷、update 不改动；非法结构 400；create 空结果 400 | 纯函数 + 路由级 + **隔离库链路5** |
| **H3** legacy PUT 未收口/无版本 | ✅ **已修复** | `routes/recordRoutes.js`：改走统一归一（写回 `sample_info`）、`version` 存在时原子条件更新、P2025→409、响应回传 version | 路由级（含 P2025）+ 隔离库链路 |
| **M1** 读优先级反了 | ✅ **已修复** | `buildRecordPayload`：三键以 `sample_info` 为准，仅缺失时回退副本；空串=显式清空不复活 | 纯函数 4 组断言 + **隔离库链路3/4** |
| **M2** 字典缺口 + 黑名单外发 | ✅ **已修复** | 新增 `allowedResultKeys`/`buildAllowedResultKeyMap`；`projectResultData` 顶层白名单（未登记丢弃 + 一次性告警）；`/v1/test-records`、`/v1/samples`、超管 preview/samples/package **全部传白名单**；字典补齐 `oil.result`、`pathogen.sampleId/sampleType/sampleInfo` | 新增 `projection-contract.test.mjs`（6 用例）+ 隔离库链路8/9 |
| **M3** 记录级字段减少无契约 | ✅ **已修复** | `docs/OPEN_API_INTEGRATION.md` §4.3 + 接入包规则 9（"按完整对象整体覆盖，不做字段级 merge"）；示例客户端新增场景 7 | `docs/examples/openapi-sync-client.mjs` 实跑通过（副本残留 2→1 条） |
| **M4** `emitted:false` 不可见 | ✅ **已修复** | 字典字段表新增 `emitted` 列说明 + `emitted:false` 语义写入对接文档与字典 notes | 文档/字典渲染 |
| **M5** status 无白名单 / 冲突回显他人记录 | ✅ **已修复** | 新增 `resolveWritableStatus`（editor 不可归档，manager/admin 可；已归档允许保持）；sync add/update、records create/update、legacy PUT 全部接入；`record_code` 冲突仅在 `canModifyRecord` 通过时按幂等返回，否则 409 且不回显 | 路由级 4 用例 + **隔离库链路7** |
| **M6** 导入脚本 | ⚠️ **部分修复（按最小影响原则）** | 更新两处过时注释 + `backend/scripts/README.md` 新增"存量脚本现状"章节（执行模式、与现行口径差异、不得悄悄改默认的约定）；**未改**脚本行为、哈希、默认执行方式 | 仅文档/注释；未跑脚本 |
| **L1** 注释与实现不一致 | ⚠️ **暂缓**（`syncRoutes.js` `/queue` 注释称 completed，实删 archived；与本轮数据面无关，改动需同步 `docs`） | — | — |
| **L2** `result_data:null` 字面键 | ✅ **已修复** | `CONTROL_KEYS` 统一剔除传输层键与三键副本 | 路由级用例（null/{}） |
| **L3** 非对象 `sample_info` 丢副本 | ✅ **已修复** | `normalizeWriteJson` 对非对象直接 400（`INVALID_SAMPLE_INFO`），不再静默丢弃 | 纯函数/路由级（非法结构 400） |
| **L4** 测试缺口 | ✅ **已补齐** | 见 C 节（新增路由级 + 数据库级；`/tmp` 复现逻辑已迁入仓库） | — |

**明确"核验不成立"的项**：无（H1/H2/H3/M1/M2/M3/M4/M5 均已修复；M6 部分修复并说明原因）。

## C. 最终字段规则（写入与读取，唯一口径）

1. **权威位置** = `TestRecord.sample_info`（读时展开为顶层三键）；`result_data` 内同名键 = 历史副本。
2. **请求内优先级：顶层 > `sample_info` > `result_data`**。依据真实调用方：Web 客户端（`core/Storage.js` 送扁平对象）与 App 都直接操作顶层；嵌套位置视为客户端携带的存储细节。
3. **本次请求提交的值恒优先于数据库旧值**；局部更新时未提交字段保留旧值（例：只提交 `result_data.canteen` → `sample_info.canteen` 更新，`inspector` 保留）。
4. `null` / 空字符串 / 缺键 = **未提交**（三键**不允许清空**）：整对象替换入口 400（`validateRecordPayload`）；局部更新入口保留旧值。
5. **读取**：权威位置有值（含 `''`）即用权威值；仅 `undefined`/`null` 回退副本 → 显式清空不得让副本复活。
6. `result_data`：`{}`/未提交在 **update** = 不改动；在 **create** = 回退扁平载荷；空结果 → 400 `EMPTY_RESULT_DATA`；字符串/数组 → 400 `INVALID_RESULT_DATA`。
7. **控制字段**（`CONTROL_KEYS`）永不进入 `result_data`：`status`/`version`/`id`/`record_code`/`test_type`/`test_name`/`created_at`/`updated_at`/`completed_at`/`created_by`/`expected_updated_at`/`sync_time`/`last_sync_at`/`sample_info`/`result_data`/`action`/`store`/`syncId`/`timestamp` + 三键副本。
8. **状态白名单**：editor = `pending/completed/failed`；manager/admin 追加 `archived`；已是 `archived` 允许保持。
9. **对外字段白名单**：`result.*` 只下发字段字典登记的键（含学校自定义字段）；容器内继续递归剔除内部字段与 PII。
10. `record_code` 幂等键**不受**上述归一影响（由入参 payload 计算）；`record_code` 冲突仅在调用者有权覆盖该记录时视为幂等重试。

## D. 兼容性影响

| 受影响方 | 影响 | 说明 |
|---|---|---|
| **Web 客户端（仓库内唯一可核验客户端）** | **无影响** | 载荷是扁平对象 + 服务端返回仍是扁平 → 读写口径不变；`status` 白名单不阻断其常用值（`completed/pending/failed`）；本地缓存不再出现 `sample_info` 嵌套分支 |
| **App（`/api/sync/*`）** | ⚠️ **待对方确认载荷形态**（源码不在仓库） | ① 只提交 `result_data` 内食堂/日期/检测人的 update → 现在**会被保留**（修复），但若 App 期望"提交 `result_data` 即整体替换"语义，仍成立（同字段行为不变）；② 缺三键的 add 现在 **400**（原先静默写空记录）——若 App 存在该形态需同步修；③ `status='archived'` 现在被拒（editor） |
| **legacy `/api/test-records`（PUT）** | ⚠️ 协议变化 | 现在会归一 + 回传 `version`；携带 `version` 时启用原子条件更新（冲突 409 `VERSION_CONFLICT`）。**仓库内无调用方**（全仓 grep 仅集成测试用 DELETE），故风险低；如需兼容旧调用方，见 E 节迁移说明 |
| **历史冲突记录（`sample_info` 与副本不一致）** | ⚠️ 展示值可能变化 | 修复后一律以 `sample_info` 为准：若历史上二者不同，**前端/导出/开放接口会统一显示 `sample_info` 的值**（此前前端显示副本值）。本次**未批量改库**；实测 4 租户 1195 条副本与权威值**冲突 0 条**，故预期无实际影响；如出现差异，属"修正为权威值"，需业务确认后逐一核对（脱敏示例建议：`canteen='一食堂'(sample_info) vs '旧值'(result_data副本)`） |
| **第三方同步（朴食）** | ⚠️ 需按新契约实现 | ① `result.*` 改为白名单（未登记字段不再下发，已补齐实测在用字段）；② 新增"记录级字段减少 → 整体替换"规则；③ `result.inspector` 恒不下发（`emitted:false`）。**尚未联调**，无存量依赖 |
| **导入脚本产出** | ⚠️ 与现行口径不一致（刻意保留） | 两个 `*-backup.mjs` 仍写副本 → 不得宣称"所有新记录都无副本"；已在 `backend/scripts/README.md` 明示 |

## E. 验证证据（本轮实际运行）

| 层级 | 命令 | 结果 |
|---|---|---|
| 纯函数 | `cd backend && node --test tests/records/record-normalize.test.mjs` | 14 用例全过（优先级矩阵、空/非法载荷、读优先级、状态白名单、幂等键） |
| 路由级（无 DB，真实 handler + 桩 `req.db`） | `node --test tests/records/route-write-paths.test.mjs` | 24 用例全过（sync add/update/batch、records create/put/bulk、legacy create/put、冲突、权限拒绝、字典同源） |
| 开放接口契约 | `node --test tests/openapi/` | 22 用例全过（含新增 `projection-contract.test.mjs` 6 用例：白名单、容器内 PII、字典补齐、样例⊆白名单、自定义字段进白名单） |
| **合计单测** | `node --test tests/` | **66 tests / 65 pass / 0 fail / 1 skipped**（skipped = 未设隔离库标记） |
| **数据库级（隔离库）** | `/tmp/run-db-tests.sh`（= 建库→`prisma db push`→`node --test tests/records/db-integration.test.mjs`） | **10/10 通过**：真实 JSON 读写、链路 1~10、唯一约束、P2025 版本冲突、租户隔离（public 无同名表） |
| 参考客户端 | `node docs/examples/openapi-sync-client.mjs` | 7 场景全过（含新增"记录级字段减少"） |

**隔离测试环境说明**（本轮新建，非生产数据）：独立数据库 `foodsentinel_review_test`（本机 PG 实例），租户 schema `school_reviewtest`（`prisma db push` 建 21 张表）。
重建步骤（无需改动任何生产配置）：
```bash
sudo -u postgres psql -c "CREATE DATABASE foodsentinel_review_test OWNER foodsentinel"
sudo -u postgres psql -d foodsentinel_review_test -c "CREATE SCHEMA IF NOT EXISTS school_reviewtest AUTHORIZATION foodsentinel"
# 以 .env 的 DATABASE_URL 为基底换库名（脚本见 backend/tests/records/db-integration.test.mjs 头部注释）
bash /tmp/run-db-tests.sh
```
测试自带守卫：`REVIEW_TEST_DATABASE_URL` 不含 `review_test` 时**拒绝运行**（防误连生产）。

## F. 未验证项与剩余风险

1. **App 载荷形态未知**（源码不在仓库）→ H1/H2 的真实触发概率、以及"缺三键的 add 现在 400"是否会打断 App 同步，**仍未验证**；建议联调前用真实 App 抓一次 `POST /api/sync/records` 报文。
2. **本轮修复未部署**：生产服务仍在运行修复前代码（含 H1/H2/H3/M5 的原始缺陷）；同时"部署后行为"只能由上面的本地/隔离库证据外推——**未做线上端到端**（本轮不授权发布）。
3. **并发/时序**：批量部分失败后的客户端重试收敛、`updated_at` 水位边界、多实例限流等仍未有 DB 级并发测试。
4. **M6 遗留**：两个导入脚本仍产出历史副本（刻意）；`fix-canteen-from-location.mjs` 用基础 prisma（打 `public`）且只改 `sample_info` → 该脚本**在生产上基本不命中**，需单独立项修（本轮未动）。
5. **`/health` 无版本标识** → 建议后续加入"启动时间 + 源码指纹（backend 源文件哈希）"，使"线上是否包含某修复"可从外部独立验证（本轮未实现，避免扩大改动面）。
6. **自由文本边界**：`remarks`/`riskReason` 等自由文本字段不做人名脱敏（契约已明示），若业务要求需另立规则。

## G. 建议发布步骤与回滚

**是否需要迁移**：❌ **不需要**。本轮改动**不含 schema 变更**（无新增表/列/索引，`prisma/migrations/` 无新文件）→ 无需 `migrate deploy`、无需 `db push`。

**发布步骤**（待用户授权后执行）：
1. `cd /opt/foodsentinel/frontend && npm run build:prod` —— **仅当需要前端产物**；本轮前端未改（`dist/` 无需重建，可跳过）。
2. `sudo systemctl restart foodsentinel-api`（后端改动生效）。
3. 冒烟：`/api/health` 200；`/api/open/v1/ping` 401（路由在）；用超管界面建/改一条记录后查库确认 `result_data` 无三键副本；`PUT /api/test-records/:id` 带 `version` 冲突返回 409。
4. 建议先与 App 侧确认载荷（见 F-1）再对外宣布。

**回滚**：`git checkout -- <本轮改动的后端文件>`（或回退到 `50ef5dc`）+ `systemctl restart foodsentinel-api`。
⚠️ **数据无需回滚**：本轮不改变历史数据；已按新口径写入的记录在旧代码下仍可正常读取（旧 `buildRecordPayload` 展开 `sample_info` 即得三键）。

**已知的"旧代码读新记录"兼容性**：✅ 成立（三键由 `sample_info` 提供；`result_data` 少几个副本不影响旧读路径）。

---

# 第三轮：接入包（生成产物）外部评审处置（2026-09-16 追加）

> 来源：用户转来的外部评审，评的是**生成产物** `open-api-onboarding-2026-09-16 (1).md`（776 行 / 约 13 个 JSON 样例）。
> 处置原则（采纳评审自身建议）：**只改生成器与契约测试，绝不手改下载文件**；每条先用代码 + 真实数据核验。

## 逐条核验与处置

| # | 评审项 | 核验 | 处置 |
|---|---|---|---|
| 一.1 | 食用油 `fail` 样例返回 `pass` | ✅ **成立**。根因：样例用 `colorLevel: '深绿色'`，而判定规则是"仅『不合格』判不合格"；**真实数据 `colorLevel` 只有 合格 38 / 警戒 1**（根本不是颜色词） | 样例重写：pass → `合格`+tpm 0.06+酸 0.3+油温 35（全部与实测一致）；fail → `不合格`+tpm 0.31（>0.25）+酸 5.2（≥5）自洽。**新增契约测试：fail 场景必须推导出 fail** |
| 一.2 | TPM 单位与缩放歧义 | ✅ **成立**（真实口径：原始 g/100g 数值；前端阈值 0.13/0.25，展示 `toFixed(2) g/100g`） | 字典改写：单位 `g/100g（数值等价于 %）`+「`0.06` = 0.06 g/100g，**勿再 ×100**」+ 判定阈值 + 实测范围；酸价补单位/阈值/实测分布；油温补"实测恒 35" |
| 一.3 | 病原体复检样例混淆初检/最终 | ✅ **成立**，且实测：`riskLevel` 只有 `无风险/低风险/极低风险`（**无"高风险"**）；`positiveDetails` 非空 ⟺ 非无风险（18/18）；病原体 `finalStatus` **0/66** | 样例重写：riskLevel 用真实值；明确「riskLevel/positiveDetails/positiveItems = **初检证据**，复检结论在 `recheckReports[].isPassed`，`allTestItems` 为当前明细」；**不再给病原体产出 finalStatus**；字典补三条语义 + "有风险 ≠ 确诊阳性" |
| 一.4 | 复检时间与 `updated_at` 不自洽 | ✅ **成立**（实测 12 条含复检记录 `updated_at` 均 ≥ `created_at`） | `sampleBase` 增加 `updatedAt`：复检场景 = 复检时间（tableware 15:31 / pathogen 16:00）；并补时区说明（顶层 ISO+08:00；`recheckRecords[].time` 为**无时区本地时间字符串**） |
| 一.5 | 「其他非空风险等级视为阳性」过宽 | ✅ 措辞过宽，但**行为与 `/stats` 一致 → 不改行为**（改了会制造新分叉） | 只改措辞：非「无风险」= **不合格/有风险**；是否检出看 `positiveDetails`；`is_positive` 同口径说明 |
| 二.1 | 删除判定应后移 | ✅ 成立 | 同步规则重写为 7 步（**二读 digest 一致后才提交与执行"缺失"处理**）+ **重试上限**（单轮 ≤5 次 / ≤10 分钟）；契约测试断言"撤回段落在二读之后" |
| 二.2 | 「清单中没有」≠物理删除 | ✅ 成立 | 改为「**当前有效范围内已不可见**」+ 列出三种成因（业务日期/状态/类型可见性）+ 禁止推断物理删除 |
| 二.3 | 「增量唯一依据」 | ✅ 成立 | 接入包与对接文档同步改写：`updated_at` 仅用于**排序**；完整同步须结合游标 + `scope_version` + `digest` |
| 二.4 | `next_cursor` 语义缺失 | ✅ 成立 | 补 5 条：只在处理完一页后保存 / 最后一页 `null` 时清空 / 游标**不是**水位（绑定项与失效条件）/ 不建议跨轮长期保存 / `since` 重叠回拉 |
| 二.5 | 字段清除不能只靠指纹 | ✅ 上一轮已修（规则 9），本轮并入统一表述 | 合并为"**整体替换**"单一规则 + 检查清单勾选项 |
| 三 | 字典缺口 | ✅ 部分成立 | 已补：油品四字段语义/阈值/实测、病原体三字段语义与枚举、`finalStatus` 说明、**结论来源**改为"录入时保存文本 → 映射"、数值口径注。**未做**：全量 enum 列表、`array<object>` 子结构小节、`data_version`/`record_code` 唯一性范围、required/nullable 三态定义、`emitted:false` 移入附录 |
| 四 | 结构重排 / 可运行示例 / 外层样例 / 错误码动作 | ⚠️ 部分执行 | 已加：`## 0 快速开始`（5 条可运行 curl）、**分页与清单外层结构样例**、错误码 **"你方应做什么"列**（含 5xx/超时）。**未做完整重排**（评审自身也是"先修样例/单位/同步顺序，再调排版"） |
| 五 | 生成器自动检查 + 顶部声明 | ✅ 已做 | 新增 `backend/tests/openapi/package-contract.test.mjs`（6 项，含**对自动生成文本的断言**）；接入包顶部加"**生成时授权快照**（学校清单）+ 实际权限以 `/profile` 为准" |

## 本轮证据

- 单测 `cd backend && node --test tests/`：**78 项（77 pass / 1 skipped）**（新增 package-contract 6 项）
- 隔离库集成：**10/10**（本轮改动无连带破坏）
- **离线重渲染接入包**（`/tmp/render-pack.mjs` → `/tmp/pack-after.md`，633 行）：场景→结论实测为
  `tableware pass/ fail/ recheck_passed`、`oil pass/ fail`、`pathogen pass/ positive/ recheck_passed` 全部自洽（`oil/fail → final=fail`）；快照声明 / 认证措辞 / `next_cursor` 语义 / 413 处理 / 二读顺序 / 清单缺失≠删除 / 整体替换 **全部命中**

## 未完成与剩余（记入后续）

1. 接入包**完整结构重排**（快速开始 → 授权快照 → 接口 → 同步规则 → **公共字段只写一次** → 各类型字段 → 错误码 → 样例附录 → 检查清单）；当前公共字段仍在每种类型下重复。
2. 字典细项：`status` 等枚举全量清单、`array<object>` 子结构独立小节、`data_version` 语义、`record_code` 唯一性范围（跨校唯一）、`required/nullable` 的缺键/`null`/`""`/`[]` 定义、把 `emitted:false` 字段移入"历史兼容与不返回字段"附录。
3. **未核验**：线上接口行为（本轮未发布）；评审手上的 776 行文件对应的具体生成版本（我无法访问该下载文件，按内容特征判断为修复前版本）——**请以本轮重渲染结果为准**。

---

*本报告第一轮为原始审阅记录（保留未改）；第二轮为修复与验证；第三轮为接入包外部评审处置。三轮均未执行提交、推送、构建发布、重启或生产数据变更。*
