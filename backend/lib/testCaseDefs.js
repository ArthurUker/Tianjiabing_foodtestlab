/**
 * testCaseDefs.js — 浏览器测试用例定义（唯一权威副本）
 *
 * 该清单是「浏览器验证操作流程」各用例的单一数据源，供两处共用：
 *   1. 后端：testResultRoutes.js（GET /api/test-results/defs）与 testReportSync.js（生成 docs 报告）
 *   2. 前端：test-report.html（从 /api/test-results/defs 动态拉取，渲染填报表单）
 *
 * 不要再在 test-report.html 里维护第二份硬编码清单。
 * case_group: wcn_业务 = 吴翠楠；zsp_备份 = 曾水平
 */

export const CASE_DEFS = [
  { group: 'wcn_业务', groupName: '吴翠楠 · 业务功能复测（第一部分~第三部分 + 回归）', cases: [
    { id: 'Q1-果蔬阶段A', title: 'Q1 复检显示·果蔬农残（阶段A 不刷新）' },
    { id: 'Q1-果蔬阶段B', title: 'Q1 复检显示·果蔬农残（阶段B 刷新）' },
    { id: 'Q1-果蔬阶段C', title: 'Q1 复检显示·果蔬农残（阶段C 切菜单）' },
    { id: 'Q1-肉蛋', title: 'Q1 复检显示·肉蛋农残（三阶段）' },
    { id: 'Q1-油', title: 'Q1 复检显示·食品油品质（三阶段）' },
    { id: 'V8-基本信息', title: 'V8 基本信息「保存修改」无反应排查' },
    { id: 'V8-界面定制', title: 'V8 界面定制「保存定制」无反应排查' },
    { id: 'V1-肉蛋', title: 'V1 界面定制·肉蛋新增检测项目显示' },
    { id: 'V1-果蔬', title: 'V1 界面定制·果蔬新增检测项目显示' },
    { id: 'V6-帮助跳转', title: 'V6 登录页帮助中心跳转（子路径矛盾复现）' },
    { id: 'V7-负向', title: 'V7 超管登录·学校代码非法输入负向' },
    { id: '回归V2', title: '回归·停用/启用用户' },
    { id: '回归V3', title: '回归·检测频率与月报页' },
    { id: '回归V4', title: '回归·阈值/日历设置保存' },
    { id: '回归V5', title: '回归·每日登录提示' },
    { id: '回归V6地址', title: '回归·帮助链接子路径地址核对' },
    { id: '回归V7正向', title: '回归·学校登录跳转正向' },
  ]},
  { group: 'zsp_备份', groupName: '曾水平 · 备份与恢复模块（第四部分 B1-B9）', cases: [
    { id: 'B1', title: 'B1 运维备份 Tab 可见性（超管可见/非超管不可见）' },
    { id: 'B2', title: 'B2 备份列表显示' },
    { id: 'B3', title: 'B3 立即备份全部' },
    { id: 'B4', title: 'B4 单校备份（独立测试学校）' },
    { id: 'B5', title: 'B5 离线验证（表数一致）' },
    { id: 'B6', title: 'B6 下载（密文 .aes / 明文 403）' },
    { id: 'B7-负向', title: 'B7 影子恢复·确认词错误不执行' },
    { id: 'B7-正向', title: 'B7 影子恢复·正向执行 + 数据回滚核对' },
    { id: 'B7-旧schema', title: 'B7 旧 schema 保留与清理（SSH psql）' },
    { id: 'B8', title: 'B8 维护模式写阻断（可选）' },
    { id: 'B9', title: 'B9 SSH 侧检查（定时任务/文件权限/失败告警）' },
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
