#!/usr/bin/env node
/**
 * gen-retest-guide.mjs — 从 testCaseDefs.js 的唯一权威副本生成「历史问题复测」md 指导文件
 *
 * 设计目标：test-report.html 网页与 docs/测试安排-历史问题复测-*.md 两个产物
 * 都从 backend/lib/testCaseDefs.js 的 guide 字段读取，做到"一份维护、处处同步"。
 * 本脚本负责把 defs 里的 guide 渲染成 md（网页由前端直接渲染）。
 *
 * 用法：node scripts/gen-retest-guide.mjs
 * 产物：docs/测试安排-历史问题复测-<日期>.md
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { CASE_DEFS } from '../backend/lib/testCaseDefs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const docsDir = path.resolve(__dirname, '../docs')
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const outFile = path.join(docsDir, `测试安排-历史问题复测-${today}.md`)

// 分工说明
const ASSIGN = {
  R1: '邬祥俊', R2: '邬祥俊', R3: '曾水平', R4: '邬祥俊', R5: '曾水平',
  R6: '曾水平', R7: '邬祥俊', R8: '吴翠楠', R9: '吴翠楠', R10: '吴翠楠',
  R11: '吴翠楠', R12: '吴翠楠', R13: '曾水平', R14: '邬祥俊',
  R15: '邬祥俊', R16: '邬祥俊', R17: '邬祥俊', R18: '邬祥俊', R19: '吴翠楠',
  R20: '吴翠楠', R21: '邬祥俊', R22: '邬祥俊', R23: '邬祥俊',
  R24: '吴翠楠', R25: '曾水平', R26: '曾水平', R27: '曾水平', R28: '吴翠楠',
}

const retest = CASE_DEFS.find((g) => g.group === 'retest_复测')
if (!retest) {
  console.error('❌ 未找到 retest_复测 分组，请检查 testCaseDefs.js')
  process.exit(1)
}

// 用 guide 的「目的」行做章节副标题
function parseGuide(guide) {
  const lines = (guide || '').split('\n').filter((l) => l.trim())
  const purpose = lines.find((l) => l.includes('目的'))?.replace(/^目的[:：]\s*/, '') || ''
  const steps = lines.filter((l) => /^步骤/.test(l)).map((l) => l.replace(/^步骤[:：]\s*/, ''))
  const verdict = lines.find((l) => l.includes('判定'))?.replace(/^判定[:：]\s*/, '') || ''
  return { purpose, steps, verdict }
}

// 从用例 title 提取 R 编号（如 title="R01 学校列表：..." → "R01"，保留前导零统一2位）
function rNo(c) {
  const m = c.title.match(/^R(\d+)/)
  if (m) return `R${m[1].padStart(2, '0')}`
  // 兼容旧版无前导零 title
  const m2 = c.id.match(/^R-(\d+)/)
  return m2 ? `R${m2[1].padStart(2, '0')}` : c.id
}

const lines = []
lines.push(`# 历史问题复测安排（最终版）`)
lines.push(``)
lines.push(`> 生成日期：${today}（由 scripts/gen-retest-guide.mjs 从 testCaseDefs.js 自动生成）`)
lines.push(`> 数据来源：5 份测试反馈 Excel（邬祥俊 / 曾水平 / 吴翠楠 / 浏览器测试验证 ×2）`)
lines.push(`> **本文件与 test-report.html 网页同步**——两者都从 backend/lib/testCaseDefs.js 读取，`)
lines.push(`> 修改只需改 defs，再运行本脚本重新生成即可，不会出现"一个更新一个老样子"。`)
lines.push(`> 环境：\`http://111.231.166.161:8080/\``)
lines.push(`> 报告上报：\`http://111.231.166.161:8080/test-report.html\`（每项都有内联测试步骤，直接照做）`)
lines.push(``)

// 分工总览
lines.push(`## 一、本次分工总览（${retest.cases.length} 项）`)
lines.push(``)
lines.push(`| 人员 | 负责条目 | 数量 |`)
lines.push(`|---|---|---|`)
const byPerson = {}
for (const c of retest.cases) {
  const no = rNo(c)
  const assignKey = no.replace(/^R0+(\d+)$/, 'R$1') // R01 → R1（匹配 ASSIGN key）
  const p = ASSIGN[assignKey] || '待定'
  byPerson[p] = byPerson[p] || []
  byPerson[p].push(no)
}
const personOrder = ['吴翠楠', '曾水平', '邬祥俊']
for (const p of personOrder) {
  if (byPerson[p]) {
    lines.push(`| ${p} | ${byPerson[p].join(' · ')} | ${byPerson[p].length} |`)
  }
}
lines.push(``)
lines.push(`> 说明：分工详见下方各用例标注。邬祥俊负担较重（多平台超管侧），如任务过重可把`)
lines.push(`> R21/R22/R23（登录相关，简单）分给曾水平或吴翠楠协助。`)
lines.push(``)

// 各用例详情（从 defs guide 渲染）
lines.push(`## 二、各用例测试步骤指导`)
lines.push(``)
for (const c of retest.cases) {
  const no = rNo(c)
  const { purpose, steps, verdict } = parseGuide(c.guide)
  lines.push(`### ${no} ${c.title.replace(/^R\d+\s*/, '')}`)
  lines.push(``)
  lines.push(`> 负责人：${ASSIGN[no] || '待定'}`)
  lines.push(``)
  if (purpose) lines.push(`**目的：** ${purpose}`)
  if (steps.length) {
    lines.push(``)
    lines.push(`**步骤：**`)
    for (const s of steps) {
      lines.push(`- ${s}`)
    }
  }
  if (verdict) {
    lines.push(``)
    lines.push(`**判定：** ${verdict}`)
  }
  lines.push(``)
}

// 原始 guide 全文（便于核对）
lines.push(`---`)
lines.push(`## 附：原始 guide 全文（与 test-report.html 网页完全一致）`)
lines.push(``)
for (const c of retest.cases) {
  lines.push(`**${rNo(c)}** ${c.title}`)
  lines.push(`\`\`\``)
  lines.push(c.guide || '(无)')
  lines.push(`\`\`\``)
  lines.push(``)
}

fs.writeFileSync(outFile, lines.join('\n'), 'utf8')
console.log(`✅ 已生成：${outFile}`)
console.log(`   共 ${retest.cases.length} 项用例`)
