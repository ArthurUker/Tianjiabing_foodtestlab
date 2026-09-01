/**
 * testCaseDefs.js — 浏览器测试用例定义（唯一权威副本）
 *
 * 该清单是「浏览器验证操作流程」各用例的单一数据源：
 *   后端：testResultRoutes.js（GET /api/test-results/defs 供前端渲染任务列表）
 *   前端：经 admin-schools.html 左侧菜单「测试报告」原生三视图
 *         （frontend/js/modules/adminSchools/views/testReports/）动态拉取渲染，
 *         不再使用已废弃的 test-report.html 独立页面。
 *
 * 本清单为「生产环境备份与恢复功能验证」专项（2026-08-26 重排）：
 *   按角色视角 + 操作类型分组，覆盖全库/单校备份、超管/学校 manager 恢复、
 *   批量与全量恢复、租户隔离、数据范围审计。负责人统一标注「待分配」。
 */

export const CASE_DEFS = [
  { group: 'backup_verify_admin', groupName: '超管端备份验证（待分配）', cases: [
    { id: 'BK-A1', title: 'BK-A1 全库备份触发与完成确认',
      guide: '目的：超管触发全库备份能正常完成并生成已验证记录。\n步骤：1.平台超管登录 admin-schools.html → 左侧「运维备份」（或对应备份视图）。2.点「立即备份全部」/全库备份按钮 → 确认框点确定。3.等待提示备份完成。4.看列表最上方新记录：类型=全库（紫色「全库」徽章）、校验=已验证、文件为 .sql.gz.aes。\n判定：出现新的全库备份记录且校验状态=已验证 → 通过；备份失败/无新记录 → 失败截图（完整截取提示内容）。' },
    { id: 'BK-A2', title: 'BK-A2 单校备份触发与完成确认',
      guide: '目的：超管对指定学校触发单校备份能正常完成。\n步骤：1.超管进备份视图 → 选学校下拉框选一所学校（如 dmyz 或测试学校）。2.点「单校备份」按钮 → 确认。3.等待完成提示。4.看列表出现该校的单校备份记录（类型=单校，学校列=该校代码）。\n判定：提示完成 + 列表出现该校单校备份记录 → 通过；下拉空/失败 → 失败截图。' },
    { id: 'BK-A3', title: 'BK-A3 备份列表与元数据核对',
      guide: '目的：备份列表字段正确展示。\n步骤：1.超管进备份列表。2.核对每条记录的列：时间 / 类型（全库或单校）/ 学校 / 大小 / 校验状态 / 操作。3.点开一条记录的详情（若有），核对 file_path 指向 BACKUP_DIR 下 .sql.gz.aes，meta 含 tableCounts 与 schemaSnapshot。\n判定：各字段正常显示且与实际文件一致 → 通过；字段缺失/错乱 → 失败截图。' },
    { id: 'BK-A4', title: 'BK-A4 离线验证（sha256 + 表数一致）',
      guide: '目的：备份文件能离线验证通过。\n步骤：1.备份列表找一条记录 → 点「验证」按钮。2.看验证结果：解密成功 / 校验一致（sha256）/ 解压成功 / 表数一致。3.四项都通过后列表状态变「已验证」。\n判定：四项目全部通过 + 状态变已验证 → 通过；「表数不一致」或校验失败 → 失败截图（不要继续做恢复测试）。' },
    { id: 'BK-A5', title: 'BK-A5 下载隔离（超管可下全库/单校；学校端全库下载 403）',
      guide: '目的：下载权限符合隔离设计。\n步骤：1.超管在备份列表点一条全库备份的「下载」→ 应能得到 .aes 密文。2.再用学校 manager 账号登录本校界面 → 找同一条全库备份 → 点「下载」→ 应提示 403（全库含其他学校数据，学校侧禁止下载）。3.学校端下载本校单校备份 → 应成功得到 .aes。\n判定：超管全库可下 + 学校端全库 403 + 学校端单校可下 → 通过；任一不符 → 失败截图。' },
  ]},
  { group: 'backup_verify_school', groupName: '学校端备份验证（待分配）', cases: [
    { id: 'BK-B1', title: 'BK-B1 学校 manager 触发本校单校备份',
      guide: '目的：学校 manager 能触发本校单校备份。\n步骤：1.用某校 manager 登录本校主界面 → 左侧「数据备份与恢复」。2.点「立即备份」按钮。3.等待提示备份完成。4.看列表出现本校单校备份记录（学校列=本校代码，类型=单校）。\n判定：提示完成 + 出现本校单校备份记录 → 通过；无入口/失败 → 失败截图。' },
    { id: 'BK-B2', title: 'BK-B2 学校端列表仅见本校单校 + 全库（全库标徽章）',
      guide: '目的：学校端列表隔离正确。\n步骤：1.manager 进「数据备份与恢复」列表。2.核对：应能看到本校单校备份记录 + 平台全库备份记录（带「全库」徽章），不应看到其他学校的单校备份。\n判定：仅本校单校 + 全库可见，无他校单校 → 通过；出现他校单校记录 → 失败截图（隔离失效）。' },
    { id: 'BK-B3', title: 'BK-B3 学校端下载本校单校（AES）；全库下载被拒',
      guide: '目的：学校端下载隔离。\n步骤：1.manager 在本校列表点本校单校备份「下载」→ 应得 .aes 密文。2.点全库备份「下载」→ 应提示 403（含其他学校数据）。\n判定：本校单校可下 .aes + 全库 403 → 通过；全库能下出密文 → 失败截图。' },
    { id: 'BK-B4', title: 'BK-B4 学校端验证本校备份',
      guide: '目的：学校 manager 能离线验证本校备份。\n步骤：1.manager 在本校列表点一条本校单校备份「验证」→ 看 sha256 + 表数一致通过。\n判定：验证四项通过 → 通过；失败 → 失败截图。' },
    { id: 'BK-B5', title: 'BK-B5 operator/viewer 无备份功能入口（权限隔离）',
      guide: '目的：学校 operator/viewer 看不到备份恢复功能。\n步骤：1.用某校 operator 登录 → 看左侧菜单是否有「数据备份与恢复」。2.用 viewer 登录 → 同样查看。\n判定：operator/viewer 均无「数据备份与恢复」入口（或进入被拒） → 通过；任一角色能看到入口 → 失败截图。' },
  ]},
  { group: 'restore_verify_admin', groupName: '超管端恢复验证（待分配）', cases: [
    { id: 'BK-C1', title: 'BK-C1 超管用单校备份恢复某目标校',
      guide: '目的：超管可用单校备份把某校回滚到备份时状态。\n步骤：1.先用目标校 manager 登录 → 在某板块新增一条带唯一标记（如 BKTEST-<校>-<日期>）的记录，记住内容。2.超管进备份视图 → 选该校 → 找该校单校备份 → 点「恢复」→ 目标学校=该校 → 输入确认词 RESTORE → 执行。3.看恢复过程提示：准备中→提取中→校验中→完成。4.用该校 manager 登录核对：刚才新增的标记记录已消失（回滚到备份时）。\n判定：标记记录消失 + 其他原有数据保留 → 通过；记录仍在 → 失败截图。备注：当前为上线前测试数据环境，可任意学校执行；正式环境须谨慎。' },
    { id: 'BK-C2', title: 'BK-C2 超管用全库备份恢复某目标校（提取该校段）',
      guide: '目的：超管可用全库备份只恢复某校（提取该校段）。\n步骤：1.目标校新增一条 BKTEST 标记记录。2.超管选全库备份 → 恢复 → 目标学校=该校 → RESTORE → 执行。3.该校 manager 登录核对：BKTEST 记录消失（回滚）。\n判定：该校回滚成功 → 通过；失败 → 失败截图。' },
    { id: 'BK-C3', title: 'BK-C3 确认词错误负向拦截（不执行）',
      guide: '目的：确认词错误时恢复不执行。\n步骤：1.超管对某备份点「恢复」→ 弹出确认框。2.故意输错确认词（如 restore 小写）→ 点执行。\n判定：提示「确认词必须为 RESTORE」且未执行恢复 → 通过；直接执行了恢复 → 失败截图（严重问题）。' },
    { id: 'BK-C4', title: 'BK-C4 恢复后目标校数据正确、其他校不受影响（界面核对）',
      guide: '目的：超管恢复某校时他校零影响。\n步骤：1.选 A 校为恢复目标，B 校为观察校。2.恢复 A 校前，记录 B 校某板块记录数。3.超管恢复 A 校（用全库或 A 单校备份）。4.恢复后：A 校数据回滚到备份时；B 校 manager 登录核对数据未变。\n判定：A 回滚 + B 不受影响 → 通过；B 校数据被改动 → 失败截图（隔离失效，严重）。' },
    { id: 'BK-C5', title: 'BK-C5 超管批量恢复多校（多校分别恢复）',
      guide: '目的：验证超管对多所学校分别执行恢复时功能正常且互不干扰。\n步骤：1.选 2~3 所学校，每校先新增各自 BKTEST 标记记录。2.超管依次对每所学校执行恢复（用全库备份提取各校段，或各校单校备份），每校恢复后核对该校回滚、他校不变。3.全程观察有无串行失败/状态错乱。\n判定：多校逐一恢复均成功且各自隔离 → 通过；任一校失败或跨校影响 → 失败截图。备注：低概率场景但须保证功能正常。' },
    { id: 'BK-C6', title: 'BK-C6 超管全部学校租户同时恢复（全量回滚）',
      guide: '目的：验证超管用全库备份对全部 school_* 租户依次恢复时，全量回滚正确且每校隔离、执行稳定。\n步骤：1.对每所已注册学校（含停用校）先记录基线标记数据。2.超管用同一份全库备份，逐校执行恢复（每校提取本校段），覆盖全部租户。3.每校恢复后核对：该校数据回滚到备份时、他校不受影响；全部完成后所有学校均处备份时状态。4.观察服务稳定性（无超时/无部分失败）。\n判定：全部租户均正确回滚且零跨校影响、执行稳定 → 通过；任一校异常 → 失败截图（严重）。备注：上线前测试数据环境可执行；正式环境极罕见但须保证。' },
  ]},
  { group: 'restore_verify_school', groupName: '学校端恢复验证（待分配）', cases: [
    { id: 'BK-D1', title: 'BK-D1 学校 manager 用本校单校备份恢复（成功回滚）',
      guide: '目的：学校 manager 可用本校单校备份恢复本校。\n步骤：1.该校 manager 新增一条 BKTEST 标记记录。2.manager 进「数据备份与恢复」→ 找本校单校备份 → 点「恢复」→ 输入 RESTORE → 执行。3.恢复后核对：BKTEST 记录消失（回滚到备份时）。\n判定：本校回滚成功 → 通过；失败 → 失败截图。' },
    { id: 'BK-D2', title: 'BK-D2 学校 manager 用全库备份恢复本校（提取本校段，他校不受影）',
      guide: '目的：学校 manager 用全库备份只恢复本校段，不触他校。\n步骤：1.本校新增 BKTEST 标记记录；另选他校为观察校。2.manager 在本校列表找全库备份（带「全库」徽章）→ 点「恢复」→ RESTORE → 执行。3.核对：本校 BKTEST 消失（回滚）；他校 manager 登录确认数据未变。\n判定：本校回滚 + 他校不受影响 → 通过；他校被改动 → 失败截图（隔离失效，严重）。' },
    { id: 'BK-D3', title: 'BK-D3 学校 manager 无法恢复他校（强隔离）',
      guide: '目的：学校端恢复目标锁定本校，无他校选项。\n步骤：1.manager 进恢复界面。2.观察「目标学校」是否固定为本校（无下拉/无他校可选）。3.尝试通过接口/URL 改 targetSchoolCode 为他校 → 应被拒绝（403/强隔离）。\n判定：目标学校锁定本校、无法指定他校 → 通过；能选他校或越权恢复 → 失败截图（严重）。' },
    { id: 'BK-D4', title: 'BK-D4 operator/viewer 无恢复入口（权限隔离）',
      guide: '目的：学校 operator/viewer 不能恢复。\n步骤：1.用 operator 登录 → 看「数据备份与恢复」是否有「恢复」按钮。2.用 viewer 登录 → 同样查看。\n判定：operator/viewer 无恢复按钮或点击被拒 → 通过；任一角色能恢复 → 失败截图。' },
  ]},
  { group: 'scope_data_audit', groupName: '备份数据范围审计（待分配）', cases: [
    { id: 'BK-E1', title: 'BK-E1 全库备份数据范围核对',
      guide: '目的：确认全库备份含 public 系统表 + 所有 school_* 租户表（排除 _prisma_migrations）。\n步骤：1.取一份全库备份的 .meta.json → 看 schemaSnapshot 含哪些 schema。2.核对：应含 public（School/SchoolCustomization/User/AccountApplication/AuditLog/Session/BackupRun/TestCase/TestExecution/SystemLog/FrequencyThreshold/DetectionCalendar 等）+ 每所学校的 school_<code> schema（User/AuditLog/TestRecord/TestItem/Attachment/Guest/GuestExportRequest/Session/FieldOption）。3.确认不含 _prisma_migrations 表。\n判定：范围与预期一致（含 public + 全部 school_*，排除迁移表） → 通过；缺 schema/多表 → 失败截图并说明。' },
    { id: 'BK-E2', title: 'BK-E2 单校备份数据范围核对',
      guide: '目的：确认单校备份仅含本校 school_<code> 租户表，不含 public 系统表。\n步骤：1.取一份单校备份的 .meta.json → 看 schemaSnapshot。2.核对：应仅含 school_<code> 一个租户 schema（User/AuditLog/TestRecord/TestItem/Attachment/Guest/GuestExportRequest/Session/FieldOption），不含 public 任何表。\n判定：仅本校租户表、无 public → 通过；含 public 或他校 → 失败截图。' },
    { id: 'BK-E3', title: 'BK-E3 备份文件结构核对',
      guide: '目的：确认备份产出文件结构正确。\n步骤：1.在 BACKUP_DIR 下看备份文件：应有一对 all-databases.<ts>.sql.gz.aes（或 <schema>.<ts>.sql.gz.aes）+ 同名 .meta.json。2.核对 .aes 权限 600、为 gzip 加密流；.meta.json 含 sha256（checksum）、tableCounts（各表行数）、schemaSnapshot（结构快照）。\n判定：.aes + .meta.json 齐全且 meta 字段完整 → 通过；缺文件/字段 → 失败截图。' },
  ]},
  { group: 'guest_permission', groupName: '访客权限验证（待分配）', cases: [
    { id: 'GP-F1', title: 'GP-F1 访客开关关闭时不可访问',
      guide: '目的：确认访客功能默认关闭，未开启的学校无法通过接口或页面进入。\n步骤：1.用平台超管账号登录 admin-schools.html。2.任选一所学校 → 配置抽屉中确认「开启访客功能（登录页显示访客入口）」为未勾选；若已勾选则取消并保存。3.打开该校登录页 /<code>/login.html，确认访客入口按钮不显示。4.用 curl 或接口工具对该校 POST /api/guest/quick-access，body 带 schoolCode。\n判定：登录页无访客入口 + 接口返回 403（提示「该校未开放访客访问」） → 通过；任一环节可进入或返回令牌 → 失败截图并说明。' },
    { id: 'GP-F2', title: 'GP-F2 访客开关开启后可免凭证进入',
      guide: '目的：确认超管开启后，访客可免凭证快速访问并拿到只读令牌。\n步骤：1.超管在 admin-schools.html 勾选该校「开启访客功能」并保存。2.打开该校登录页 /<code>/login.html，确认出现访客入口按钮。3.点击访客入口进入系统。4.查看浏览器 localStorage 或 Network，确认拿到访客令牌（role=guest、guest_type=readonly）。\n判定：登录页出现访客入口 + 点击后成功进入且令牌 role=guest → 通过；入口不出现或点击报错 → 失败截图并说明。' },
    { id: 'GP-F3', title: 'GP-F3 访客模块白名单不含致病菌',
      guide: '目的：确认访客看不到致病菌模块，且直接访问会被后端拒绝。\n步骤：1.以免凭证访客身份进入系统。2.查看左侧/顶部导航或模块列表，确认无「致病菌」相关入口。3.若有其他业务模块（餐具/农残/食用油/瘦肉精等），点开确认可正常查看列表。4.（进阶）用访客令牌直接请求 /api/test-records/pathogen，确认返回 403。\n判定：导航无致病菌入口 + 其他白名单模块可看 + 直接请求致病菌接口返回 403 → 通过；致病菌可见或可访问 → 失败截图。' },
    { id: 'GP-F4', title: 'GP-F4 访客无导出功能',
      guide: '目的：确认访客处处无导出入口，且后端不签发导出权限。\n步骤：1.以免凭证访客身份进入各可见模块。2.确认页面无「导出 PDF」「导出 Excel」按钮（如历史版本曾出现，本次应已移除）。3.查看访客令牌内容，确认 has_export_permission 为 false。4.（进阶）若页面仍残留导出按钮，点击后确认被拒绝或提示无权限。\n判定：无导出按钮 + 令牌 has_export_permission=false → 通过；存在可用导出入口 → 失败截图并说明。' },
    { id: 'GP-F5', title: 'GP-F5 访客不能提交或修改数据',
      guide: '目的：确认访客为纯只读，任何写操作被后端拒绝。\n步骤：1.以免凭证访客身份进入任一可见模块。2.确认无「新增」「编辑」「删除」按钮，表单（若有）为只读或禁用。3.（进阶）用访客令牌对 /api/test-records 发 POST/PUT/DELETE 请求。\n判定：页面无写操作入口 + 写请求返回 403 → 通过；出现可提交的写入口或写请求成功 → 失败截图。' },
    { id: 'GP-F6', title: 'GP-F6 访客无自助注册与登录通道',
      guide: '目的：确认已下线的自助注册/登录通道确实不可达（2026-09-01 清理）。\n步骤：1.用接口工具对该校 POST /api/guest/register（带 schoolCode/username/password）。2.再请求 POST /api/guest/login。\n判定：register 返回 403（提示申请 viewer 账号）、login 返回 404 或路由不存在 → 通过；任一接口返回令牌或注册成功 → 失败截图并说明。' },
    { id: 'GP-F7', title: 'GP-F7 访客令牌 2 小时后过期',
      guide: '目的：确认访客令牌有效期为 2 小时且过期后失效。\n步骤：1.以免凭证访客身份进入，记录进入时间并取出令牌（看 exp 或 iat 字段，有效期应为 2h）。2.等待至超过 2 小时（或临时改小后端硬编码的 expiresIn 后重测）。3.过期后用该令牌请求任意接口（如 /api/guest/verify-token 或 /api/test-records）。\n判定：令牌 exp - iat = 7200 秒（2h）+ 过期后请求被拒（401/403）→ 通过；有效期非 2h 或过期仍可用 → 失败截图并说明。' },
    { id: 'GP-F8', title: 'GP-F8 访客登出后清理干净',
      guide: '目的：确认访客点击退出后，本地状态被清除且不会残留访客令牌（2026-09-01 改动了 Router.js 登出流程）。\n步骤：1.以免凭证访客身份进入系统。2.点击页面右上角「退出登录」或触发登出。3.确认跳转到登录页。4.检查 localStorage/sessionStorage，确认访客令牌已被清除。5.刷新页面，确认不会自动以访客身份重新进入。\n判定：跳转登录页 + 令牌已清除 + 刷新后不再是访客态 → 通过；登出报错、令牌残留或刷新后仍是访客 → 失败截图并说明。' },
    { id: 'GP-F9', title: 'GP-F9 关闭开关后存量访客立即失效',
      guide: '目的：确认超管关闭访客开关后，已发出的访客无法继续访问（fail-closed）。\n步骤：1.先开启该校访客功能，以免凭证访客身份进入，确认可正常查看数据。2.保持访客页面打开，用超管账号在另一浏览器/窗口取消勾选「开启访客功能」并保存。3.回到访客页面，刷新或切换模块触发接口请求。\n判定：开关关闭后访客请求被拒（403）或页面提示无权限 → 通过；仍可正常查看数据 → 失败截图并说明。' },
  ]},
]

/** 合法结果值 */
export const RESULT_OPTIONS = [
  ['passed', '✅ 通过'],
  ['failed', '❌ 失败'],
  ['skipped', '⏭ 跳过'],
  ['pending', '⏳ 待测'],
]

/** 结果 → 中文标签 / 颜色（报告渲染用） */
export const RESULT_LABELS = {
  passed: { label: '通过', emoji: '✅', color: '#16a34a' },
  failed: { label: '失败', emoji: '❌', color: '#dc2626' },
  skipped: { label: '跳过', emoji: '⏭️', color: '#d97706' },
  pending: { label: '待测', emoji: '⏳', color: '#9ca3af' },
}

/** 用例 id → 定义 的扁平索引 */
export function indexCaseDefs(defs = CASE_DEFS) {
  const map = new Map()
  for (const g of defs) {
    for (const c of g.cases) map.set(c.id, { ...c, group: g.group, groupName: g.groupName })
  }
  return map
}
