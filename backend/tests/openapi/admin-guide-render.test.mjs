// 超管「接入说明」渲染回归（2026-09-23）
//
// 背景：界面不再手写长文，改为渲染后端 `lib/openApiGuide.js` 的同一份内容（与接入包同源）。
// 因此必须保证：① 极简 Markdown 渲染器能正确渲染后端给出的真实内容（表格/代码块/列表/引用/行内标记）；
// ② 一切内容都经过 HTML 转义（后端内容里可能出现 <、>、& 等字符，不允许变成标签）；
// ③ 渲染器本身不吞内容（真实内容渲染后不能是空串）。
//
// 做法：从 `openApiView.js` 源码中提取 `escapeHtml` / `mdInline` / `renderMdBlocks` 三个纯函数后求值，
// 在 Node 里直接跑（无需浏览器）。提取用字符串切片 + 断言兜底：源码结构变了会直接失败提示，不会静默跳过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GUIDE_BUSINESS_RULES, GUIDE_DICT_NOTES, GUIDE_FAQ, GUIDE_SELF_CHECK, GUIDE_ERROR_ROWS, GUIDE_PARAM_RULES } from '../../lib/openApiGuide.js'

const SRC = readFileSync(new URL('../../../frontend/js/modules/adminSchools/views/openApiView.js', import.meta.url), 'utf8')

function loadRenderer() {
  const escapeStart = SRC.indexOf('function escapeHtml')
  const escapeEnd = SRC.indexOf('\n}', escapeStart)
  const mdStart = SRC.indexOf('function mdInline')
  const mdEndMark = "return out.join('')"
  const mdEnd = SRC.indexOf(mdEndMark, mdStart)
  // renderMdBlocks 的收尾是 "\n}"（函数闭合），按源码结构定位而不是硬编码长度
  const mdFnEnd = SRC.indexOf('\n}', mdEnd)
  assert.ok(escapeStart > 0 && escapeEnd > escapeStart, '未能从 openApiView.js 提取 escapeHtml')
  assert.ok(mdStart > 0 && mdEnd > mdStart && mdFnEnd > mdEnd, '未能从 openApiView.js 提取 mdInline/renderMdBlocks')
  const code = `${SRC.slice(escapeStart, escapeEnd + 2)}\n${SRC.slice(mdStart, mdFnEnd + 2)}\nreturn { mdInline, renderMdBlocks }`
  // eslint-disable-next-line no-new-func
  return new Function(code)()
}

const { mdInline, renderMdBlocks } = loadRenderer()

test('渲染器：表格 / 代码块 / 列表 / 引用 / 行内标记都能渲染', () => {
  const html = renderMdBlocks([
    '| 类型 | 判定 |',
    '|---|---|',
    '| 餐具 | `result` 含「合格」 |',
    '',
    '```bash',
    'curl -s -H "X-API-Key: $KEY" https://example.com/api/open/v1/ping',
    '```',
    '',
    '- 列表项 **加粗**',
    '> 引用提示',
  ])
  assert.ok(html.includes('<table'), '应生成表格')
  assert.ok(html.includes('<th'), '应有表头')
  assert.equal((html.match(/<td/g) || []).length, 2, '表体应有 2 个单元格')
  assert.ok(html.includes('<pre'), '应生成代码块')
  assert.ok(html.includes('curl -s'), '代码块内容应保留')
  assert.ok(html.includes('• 列表项 <b>加粗</b>'), '列表项应带项目符号并支持加粗')
  assert.ok(html.includes('border-l-2'), '引用应有左侧竖线样式')
})

test('渲染器：内容必须 HTML 转义（不得把后端文本当标签执行）', () => {
  const html = renderMdBlocks(['<img src=x onerror=alert(1)>', '- `</code><script>x</script>`'])
  assert.equal(html.includes('<img'), false, '原始标签必须被转义')
  assert.equal(html.includes('<script>'), false, '内容里的 script 不得成为真实标签')
  assert.ok(html.includes('&lt;img'), '应输出转义后的实体')
})

test('渲染器：空输入返回空串，不抛错', () => {
  assert.equal(renderMdBlocks([]), '')
  assert.equal(renderMdBlocks(null), '')
  assert.equal(mdInline(null), '')
})

test('渲染器：后端共享内容能被渲染出有效结构（表格/要点不为空）', () => {
  const rules = renderMdBlocks(GUIDE_BUSINESS_RULES)
  assert.ok(rules.includes('<table'), '业务口径里的判定表应被渲染成表格')
  assert.ok(rules.includes('初检证据') || rules.includes('is_positive'), '阶段语义要点不得丢失')
  const notes = renderMdBlocks(GUIDE_DICT_NOTES)
  assert.ok(notes.includes('required') || notes.includes('必现'), '字典读表须知不得丢失')
  assert.ok(renderMdBlocks(GUIDE_PARAM_RULES).includes('limit'), '参数规则不得丢失')
  const faq = renderMdBlocks(GUIDE_FAQ.map((f) => `**Q：${f.q}**\n\n${f.a}`))
  assert.ok(faq.includes('Q：'), 'FAQ 应能渲染')
  assert.ok(renderMdBlocks(GUIDE_SELF_CHECK.map((c) => `- ${c.item} —— 期望：${c.expect}`)).includes('期望：'), '自检清单应能渲染')
  assert.ok(GUIDE_ERROR_ROWS.length >= 10, '错误码行数与实现保持同步（当前 >= 10 行）')
})
