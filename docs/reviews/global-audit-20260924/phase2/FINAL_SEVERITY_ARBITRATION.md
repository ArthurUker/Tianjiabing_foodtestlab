# PHASE 2 — FINAL SEVERITY ARBITRATION

日期：2026-09-24。唯一代码基线：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`。

本轮为 AUDIT / DESIGN ONLY，承接 [MASTER VERDICT](PHASE2_MASTER_VERDICT.md)、[ROOT CAUSE MATRIX](ROOT_CAUSE_MATRIX.md)、[DEPENDENCY GRAPH](REMEDIATION_DEPENDENCY_GRAPH.md)。仅裁决指定 7 项；其余 16 个 P1、26 个 P2 沿用原结论，不重新验证、不吸收新候选。23/23 independently confirmed 是有效性结论，不等于最终全部 P1。

当前工作区 HEAD 为 `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，本轮补充源码证据均通过 `git show <固定基线>:<path>` 读取，未切换工作区。下列源码行号均指固定基线；审计报告是工作区已有证据。本轮未运行应用、数据库、migration、破坏性探针或访问生产。

## 1. 最终裁决

| Issue | Final severity | 裁决关键点 |
|---|---|---|
| AUD-006 | **FINAL_P1** | 在线写入可使成功备份在正式恢复时被拒，损害灾难恢复关键能力 |
| AUD-007 | **FINAL_P2** | 同范围、同秒产物命名碰撞，现有证据支持低频且局限于竞争任务的备份损失 |
| AUD-015 | **FINAL_P1** | 约 1 秒是进入窗口；漏吊销持续至过期/另一次有效撤销，refresh 可延续访问 |
| AUD-017 | **FINAL_P1** | 标准生产路由暴露，普通身份/guest 越过全局报告读写授权边界 |
| AUD-025 | **FINAL_P2** | API 可写未知颜色，但已证后果是可重算统计错误，无关键持久状态改写证据 |
| AUD-027 | **FINAL_P1** | 删除 User 物理抹除其业务 AuditLog，剩余 SystemLog 与删除事件不能替代历史 |
| AUD-044 | **FINAL_P1** | 标准 startup 接受公开示例签名密钥，无强制替换/校验层兜底 |

全部 7 项均有足够证据定级，`FINAL_PENDING = ∅`。不按修复成本、注释意图或 UI 是否提供入口定级。

## 2. 逐项理由

### AUD-006

- **Final severity：FINAL_P1。**
- **Evidence basis：**[原条目](../ISSUE_INVENTORY.md#aud-006)、[Batch B / AUD-006](BATCH-B-VERIFICATION.md)。`backend/lib/backupService.js:357–375` 先逐表计数、另取结构、再启动独立 pg_dump，无共享快照；`:378–419` 的 L1 校验检查压缩/表数量，仍可把行数漂移的产物登记为 `ok/passed`。`backend/lib/restoreService.js:174–190` 将 meta 行数与恢复结果严格比较，不一致即失败。证据为完整代码路径（B），不是本轮灾备运行实测。
- **Reachability：**正常在线备份期间有记录、会话、审计等写入即可；不需要并发两个备份或异常权限。不同表计数之间也可能漂移。
- **Consequence：**原数据库不会因此损坏，dump 本体也不必损坏；但系统宣告成功的备份包在受支持恢复路径上可能不可恢复。相同文件重复恢复仍会出现同一计数不匹配。真实灾难中源库可能已不存在，不能把“重跑源库备份”作为救济。
- **Why P1/P2：**满足“灾难恢复关键能力失效”。fail-safe 防止接受不一致产物，却不能证明灾备可用。人为重写 meta/绕过校验既不是已证实的正常恢复能力，也可能掩盖真实缺数，不能据此降 P2。不声称 SQL 永久无法人工抢救或所有备份均失败。
- **What evidence would change this decision：**若证明所有受支持备份均在全写入屏障下执行，或成功发布前强制隔离恢复并验证包内一致性，或存在可验证完整性且无需源库的正式修复恢复流程，可重新考虑 P2。仅提供“原库无损”“可以重试”不改变裁决。

### AUD-007

- **Final severity：FINAL_P2。**
- **Evidence basis：**[原条目](../ISSUE_INVENTORY.md#aud-007)、[Batch B / AUD-007](BATCH-B-VERIFICATION.md) 的真实同秒命名复现（A-）及代码路径。`backupService.js:364–398` 的同名 `.tmp/.aes/.meta` 族直接写入，失败按路径 unlink；`:431–438` 还会回写同一 meta。`backend/routes/adminBackupRoutes.js:140–149`、`schoolBackupRoutes.js:208–212`、`backend/scripts/003_backup-now.mjs:12,62` 分别提供平台、学校、CLI/timer 来源，无共同任务互斥。
- **Reachability：**相同输出目录、相同 scope/目标 schema 的两个任务，在**计算文件名时落入同一秒**，且文件操作重叠。请求到达同秒只是近似条件，因命名前还有计数。timer 默认 `--all`，只有手动全库备份与其命名冲突；同秒全库与单校不会共用 baseName。同校经理和平台管理员、重复手动请求、重复 CLI 均可竞争；不能因一个浏览器按钮防重复就排除。
- **Consequence：**可覆盖、破坏或删除竞争任务的产物，成功 BackupRun 可能指向缺失文件；不损坏源业务库，也没有证据表明会删除其他时间点的历史备份。L1 可发现部分损坏，但不能保护成功后被另一任务删除的文件；不能把“verify 可发现”写成自动恢复保证。
- **Why P1/P2：**现实可达但须叠加同 scope、同命名秒、并发文件操作；现有证据仅证明低频竞争窗口及其产物损失，未证明标准调度持续制造碰撞或关键恢复点普遍不可用。正常源库仍在时可另起任务重备，定为 localized / rare race 的 P2。与 AUD-006 的普通在线写入即可使成功包不可恢复不同。该判断不把灾难发生后“重备”视为可能，也不低估最后一份备份丢失的后果。
- **What evidence would change this decision：**标准多实例 timer 重复启动、正常人工流程可稳定触发同秒竞争、成功产物被静默清掉并被常规保留流程当作唯一有效恢复点，或已有真实恢复点损失证据，均支持升为 P1。若有跨 API/CLI/进程的强制同范围互斥证据，则需重新核定触发前提。当前没有这些保证或常态碰撞证据。

### AUD-015

- **Final severity：FINAL_P1。**
- **Evidence basis：**[原条目](../ISSUE_INVENTORY.md#aud-015)、[Batch A / AUD-015](BATCH-A-VERIFICATION.md) 及其引用的 PostgreSQL 表达式验证。`authMiddleware.js:82–102,111–129` 使用 `revoked_at >= to_timestamp(iat+1)`；`backend/routes/userRoutes.js:286–324` 的刷新也用同一判定并签发新 token pair。`UserManager.js:80–134` 默认 access 30m、refresh 7d，均可配置。
- **Reachability：**某 token 先签发/刷新、同一整数秒稍后发生 `user_all` 撤销。正常并发会话与改密操作即可进入；不要求攻击者控制服务器时钟。用户保持 active 的改密场景尤为关键。
- **Consequence：**1 秒过后 SQL 比较结果不会自行变为 true；该旧 access 可持续至其实际到期，默认最长约 30 分钟。漏吊销 refresh 可在实际 TTL 内兑换新 pair；后继 token 的签发时间晚于旧撤销记录，可能继续轮转，不能以 access TTL 或单枚 refresh 的默认 7d 作为整个失效会话的硬上限。到期、精确 jti 撤销、后续全量撤销或账号状态变化仍可能终止访问，不称“无条件永久有效”。
- **Why P1/P2：**这是已承诺的凭据失效机制失效。AUD-012 的 Session 不参与认证，不能补救；即使修好 AUD-016 的撤销事务，错误比较仍会放过边界 token。注释中的同秒重登兼容目的不能授予旧凭据豁免。窄进入窗口不等于短影响期。
- **What evidence would change this decision：**若存在所有 access/refresh 必经、事务有序且能拒绝该旧 token 的 session-version/精确撤销层，可重新判断。仅提高时间精度、描述“设计如此”或指出其他时间正常，均不能降级。

### AUD-017

- **Final severity：FINAL_P1。**
- **Evidence basis：**[原条目](../ISSUE_INVENTORY.md#aud-017)、[Batch A / AUD-017](BATCH-A-VERIFICATION.md)。本轮补核 `backend/server.js:333–335` 无环境开关挂载全局 Prisma 路由；标准部署的 `deploy/deploy.sh:875–880` 将 `/api/*` 反代到后端，没有排除此模块。`testResultRoutes.js:71–74` 仅认证；`:180–191` 读取执行历史，`:301–345` 写结案/修复状态，`:398` 上传证据；证据下载路径同属该认证路由。guest 认证可通过见 Batch A。
- **Reachability：**标准生产配置下，普通 authenticated identity（operator/viewer）及可取得有效访客 token 的 guest 均可直接请求 API。无页面按钮不构成保护。此为固定基线的生产暴露路径判断，未声称已探测现网网关。
- **Consequence：**跨主体读取 global reports、执行轨迹和证据，修改全局 issue 状态、mark fixes、上传证据；数据没有请求者租户/任务参与者限制。影响限于测试报告模块，不扩大为业务检测库任意写。
- **Why P1/P2：**满足授权绕过和跨主体暴露。任意学校访客不应天然拥有全局质量管理权限；“临时测试工具”的注释既不关闭生产路由，也不建立授权边界。无需借助 AUD-018 组合攻击即可达到 P1。
- **What evidence would change this decision：**覆盖所有生产入口的强制路由禁用/网关隔离，或服务端显式参与者、资源范围、读写权限控制，可改变生产可达性结论。仅无前端入口、没有当前数据或内部测试用途说明不足。

### AUD-025

- **Final severity：FINAL_P2。**
- **Evidence basis：**[原条目](../ISSUE_INVENTORY.md#aud-025)、[Batch C / AUD-025](BATCH-C-VERIFICATION.md)。已核定合法非空 colorLevel 为 `合格/警戒/不合格`；既有规则把警戒计入合格，空值另按 result 回退。未知非空值如 `foo` 不应沿用该规则。内部/guest SQL 用 `NOT LIKE '%不合格%'`，OpenAPI 显式枚举返回 unknown。`backend/lib/recordNormalize.js:349–361` 无 colorLevel 枚举校验。
- **Reachability：**UI 受限控件不能证明数据域受控；POST/PUT、bulk-upsert、sync、导入/legacy 数据路径可带未知值，属于真实可达输入。降级不依赖“只能 UI 写”这一错误前提，也不需要假设低概率。
- **Consequence：**油脂看板、内部/访客合格率与明细、OpenAPI 不一致，可误导检测管理与报告使用。已证实的是读时派生统计，原检测记录仍在；没有证据表明该统计自动批准食品放行、不可逆关闭整改或写入法定最终判定。
- **Why P1/P2：**业务指标重要，但现有证据支持 correctness 和可重算输出错误，未越过授权边界，也未破坏重要持久状态。不能凭食品安全领域名称推定未证明的自动决策/合规后果。已发布报告可能需更正，不能把重算说成会自动撤回外部旧报告。
- **What evidence would change this decision：**若证明该值直接驱动不可逆放行/审批、固化为重要权威状态，或已形成无法更正的重要外部业务后果，升 P1。服务端全写入口的合法枚举约束与存量数据清查则会缩小触发面，但当前没有这一保障。

### AUD-027

- **Final severity：FINAL_P1。**
- **Evidence basis：**[原条目](../ISSUE_INVENTORY.md#aud-027)、[Batch C / AUD-027](BATCH-C-VERIFICATION.md)。`schema.prisma:72–85` 的 AuditLog.user_id 非空且 `onDelete: Cascade`；`UserManager.js:932–964` 仅检查 TestRecord、最后 manager，随后物理删除 User，再以删除者 actor 写 user_delete。`schema.prisma:346–355` 的 SystemLog 无 User 外键。`backend/routes/auditRoutes.js:53–64` 把登录、角色变更、禁用/删除、密码重置列为服务端强制审计，明确区别客户端自报事件，足以证明业务追溯要求，非仅可丢弃诊断日志。
- **Reachability：**有权限的管理员删除无关联检测记录、非最后可用 manager 的用户；有登录/管理/导出审计而没有 TestRecord 是正常主体类型。
- **Consequence：**该用户作为 actor 的 Application AuditLog 行被不可逆删除（除非从其他保存副本恢复）。SystemLog 保留的是另一类/部分安全事件；删除者的一条 user_delete 记录只证明“谁删除了谁”，不能重建被删者此前做过什么。并非全系统所有审计日志消失。
- **Why P1/P2：**正常账号生命周期动作静默清除业务追溯事实，满足审计可信性重大破坏和重要持久记录丢失。TestRecord 保护与删除动作留痕缩小影响，却不满足历史保留目标。不借用未查明的法定保留年限定级。
- **数据模型裁决：**采用与登录账户解耦的 **immutable audit principal + actor snapshot**；AuditLog 对 principal 使用 RESTRICT，禁止主体级 cascade。可选 live User 引用用 SET NULL，但保留 principal ID/租户身份/历史 snapshot。账号常规删除走 soft delete；未来物理清理不能删审计。单用 User RESTRICT 是过渡止损，单用 SET NULL 会失去身份解释，单用 soft delete 仍留下硬删除破坏风险；详见架构文件 RC-09。
- **What evidence would change this decision：**若存在独立、不可变、完整覆盖这些动作且可检索的权威审计存储，并有明确政策将此 AuditLog 定义为可丢弃投影，可重新定为 P2。SystemLog 存在或删除动作有 actor 均不足以构成该证据。

### AUD-044

- **Final severity：FINAL_P1。**
- **Evidence basis：**[原条目](../ISSUE_INVENTORY.md#aud-044)、[Batch B / AUD-044](BATCH-B-VERIFICATION.md)。`.env.example:33` 的公开固定占位值不在 `backend/server.js:69–86` 的弱值拒绝列表。根 `package.json` 的 start 进入 backend，`backend/package.json` 的 start 直接 `node server.js`；不存在必经生成 secret 的 prestart。满足其他正常 DB/CORS 配置时，此值不阻断生产启动。
- **Reachability：**复制示例到实际加载的环境文件并保留 JWT_SECRET，或通过服务环境注入该值。`NODE_ENV=production` 不增补拒绝规则。这里判断标准启动可接受此值，不推测现网是否沿用。
- **Consequence：**公开密钥可用于构造签名有效凭据。DB 用户/状态/角色回查仍存在，故须冒充真实且有效的目标主体；不能把随意填写 admin role 等同于成功。但对真实管理员的冒充已构成 production authentication compromise。
- **Why P1/P2：**跨过核心认证边界，deployment-dependent 不等于仅文档风险。`deploy/deploy.sh:395–407` 会复用既有非空值，且**仅空值时**随机生成；正确的默认首次部署受保护，但脚本不是保证拒绝示例值的强制层。修正 Batch B “deploy.sh 实例一概不受影响”的过宽表述，仍属同一 issue 证据补正。修复成本不参与定级。
- **What evidence would change this decision：**全部受支持生产启动路径必经强制 secret 注入/占位校验、并在监听端口前拒绝该值的代码与部署约束，可改变结论。仅推荐使用 deploy.sh 或展示一次安全生成不够。

## 3. FINAL_P1_SET

```text
AUD-001, AUD-002, AUD-003, AUD-004, AUD-005, AUD-006,
AUD-008, AUD-009, AUD-010, AUD-012, AUD-014, AUD-015,
AUD-016, AUD-017, AUD-020, AUD-021, AUD-022, AUD-027,
AUD-039, AUD-044, AUD-047
```

## 4. FINAL_P2_SET

```text
AUD-007, AUD-011, AUD-013, AUD-018, AUD-019, AUD-023,
AUD-024, AUD-025, AUD-026, AUD-028, AUD-029, AUD-030,
AUD-031, AUD-032, AUD-033, AUD-034, AUD-035, AUD-036,
AUD-037, AUD-038, AUD-040, AUD-041, AUD-042, AUD-043,
AUD-045, AUD-046, AUD-048, AUD-049
```

## 5. 数量对账与边界

| 口径 | P1 | P2 | Pending | 合计 |
|---|---:|---:|---:|---:|
| 第一遍 | 23 | 26 | 0 | 49 |
| 本轮指定 7 项 | 5 | 2 | 0 | 7 |
| 第一遍 23 个 P1 最终去向 | 21 | 2 | 0 | 23 |
| **全 inventory 最终** | **21** | **28** | **0** | **49** |

变化仅为 AUD-007、AUD-025 从 P1 调整为 P2；没有 false positive，没有删除 issue。原 26 个 P2 的级别沿用，不声称它们全部经历 Phase 2 独立验证。NEW_FINDINGS_CANDIDATES 及其他阶段候选均不进入集合或数量。架构与实施设计见 [FINAL_ARCHITECTURE_DECISIONS](FINAL_ARCHITECTURE_DECISIONS.md)、[FINAL_REMEDIATION_WAVES](FINAL_REMEDIATION_WAVES.md)。
