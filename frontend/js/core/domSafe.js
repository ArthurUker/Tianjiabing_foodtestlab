/**
 * domSafe.js — 「业务数据 → DOM」的唯一安全通道（RC-05 / AUD-003，P3-W5-T01）
 *
 * 背景：此前列表 / 详情 / 编辑弹窗用 `innerHTML = \`...${业务字段}...\`` 直拼，业务字段
 * （remark、检测人、备注、日志内容、菜名……）既进入**文本**上下文也进入**属性**上下文
 * （`title="${remark}"`），有写入权限的账号即可持久化 `<img onerror=...>` / `" onmouseover=...`
 * 之类的载荷，等待他人打开页面时被解析为元素与事件属性（存储型 XSS 面）。仓库里另有 7+ 份
 * 各自实现的 `escapeHtml`（NF-C-02），逐处补转义既漏又容易语义分叉。
 *
 * 本模块把边界收敛到一处：**数据永远不作 markup 解析**。
 *   · `html` 模板：静态骨架仍是源码里的 HTML（可信）；**插值一律先变成占位槽**，
 *     渲染时按位置落地 —— 文本位置 → 文本节点（等价 `textContent`）；
 *     属性位置 → `setAttribute`（等价 DOM API 赋值）。
 *   · `setText` / `setAttr` / `el`：直接构造，不经字符串。
 *   · 输出为 DocumentFragment，用 `mount(target, fragment)` 替换子节点（不经 innerHTML）。
 *
 * 于是任何注入串（`"><img onerror=alert(1)>`、`</textarea><script>`、`&lt;` 变体）都只能是文本，
 * 不可能变成结构、属性或事件处理器。**新代码不得再新增 escapeHtml 分叉，也不得用字符串拼 DOM。**
 *
 * 允许的模板写法（与普通模板字面量一致）：
 *   html`<td class="p-2" title="${r.remark}">${r.canteen}</td>`
 *   —— 插值必须落在「文本位置」或「带引号的属性值位置」；不得用于拼标签名/属性名。
 */

// 占位符必须是**纯 ASCII**：HTML 解析器会丢弃部分 Unicode 私用区字符（jsdom/parse5 实测剥离
// U+E000/U+E001），ASCII 令牌在所有解析器下都原样存活。令牌只在「模板静态骨架」里出现，
// 业务值在解析**之后**才作为文本/属性落地，故值中即使含同形串也不会被再次解析（无二阶注入）。
const TOKEN_MARK = '__DOMSAFE_SLOT_'
const TOKEN_RE = /__DOMSAFE_SLOT_(\d+)__/g
const hasToken = (s) => typeof s === 'string' && s.includes(TOKEN_MARK)

/** 模板产物：静态骨架 + 槽位表（槽位以私用区占位符标记，不可能由插值本身生成）。 */
export class SafeFragment {
    constructor(markup, slots) {
        this.markup = markup
        this.slots = slots
    }
}

let _seq = 0
function nextToken() {
    _seq += 1
    return `${TOKEN_MARK}${_seq}__`
}

function isSafeFragment(value) {
    return value instanceof SafeFragment
}

/** 把一段可信静态骨架与插值合并为 SafeFragment；嵌套 SafeFragment 内联（其槽位一并合并）。 */
export function html(strings, ...values) {
    let markup = ''
    const slots = new Map()
    const appendValue = (value) => {
        if (value === null || value === undefined || value === false || value === true) {
            // 布尔/空值：按"无内容"处理（保留历史模板 `cond ? html`…` : ''` 的书写习惯）
            return
        }
        if (isSafeFragment(value)) {
            markup += value.markup
            for (const [token, v] of value.slots) slots.set(token, v)
            return
        }
        if (Array.isArray(value)) {
            for (const item of value) appendValue(item)
            return
        }
        const token = nextToken()
        slots.set(token, value)
        markup += token
    }
    for (let i = 0; i < strings.length; i++) {
        markup += strings[i]
        if (i < values.length) appendValue(values[i])
    }
    return new SafeFragment(markup, slots)
}

/** 文本节点 / 属性值中的槽位替换（文本用文本节点，属性用 setAttribute，绝不二次解析）。 */
function substituteString(raw, slots) {
    return String(raw).replace(TOKEN_RE, (token) => {
        const v = slots.get(token)
        return v === null || v === undefined ? '' : String(v)
    })
}

function replaceTextNode(node, slots) {
    const doc = node.ownerDocument
    const raw = node.nodeValue
    const frag = doc.createDocumentFragment()
    let last = 0
    TOKEN_RE.lastIndex = 0
    let m
    while ((m = TOKEN_RE.exec(raw)) !== null) {
        if (m.index > last) frag.appendChild(doc.createTextNode(raw.slice(last, m.index)))
        const v = slots.get(m[0])
        frag.appendChild(doc.createTextNode(v === null || v === undefined ? '' : String(v)))
        last = m.index + m[0].length
    }
    if (last < raw.length) frag.appendChild(doc.createTextNode(raw.slice(last)))
    node.parentNode.replaceChild(frag, node)
}

function applySlots(node, slots) {
    if (!node) return
    if (node.nodeType === 1) { // Element：属性走 setAttribute
        for (const name of node.getAttributeNames()) {
            const raw = node.getAttribute(name)
            if (hasToken(raw)) node.setAttribute(name, substituteString(raw, slots))
        }
        for (const child of Array.from(node.childNodes)) applySlots(child, slots)
    } else if (node.nodeType === 3) { // Text：槽位变文本节点
        if (hasToken(node.nodeValue)) replaceTextNode(node, slots)
    } else if (node.childNodes && node.childNodes.length) {
        // DocumentFragment（template.content 是 #document-fragment，nodeType=11）等容器：继续下钻
        for (const child of Array.from(node.childNodes)) applySlots(child, slots)
    }
    // 注释节点不动：其内的占位符不产生结构/事件/可见文本
}

/** SafeFragment / 数组 / 基本值 → Node 数组（用于 mount / 追加）。 */
export function toNodes(value) {
    if (value === null || value === undefined || value === false || value === true) return []
    if (Array.isArray(value)) return value.flatMap((v) => toNodes(v))
    if (value instanceof Node) return [value]
    const fragment = isSafeFragment(value) ? value : html`${value}`
    const tpl = document.createElement('template')
    tpl.innerHTML = fragment.markup
    if (fragment.slots.size) applySlots(tpl.content, fragment.slots)
    return Array.from(tpl.content.childNodes)
}

/** 用 fragment 的内容**替换** target 的子节点（不经 innerHTML）。 */
export function mount(target, value) {
    if (!target) return target
    target.replaceChildren(...toNodes(value))
    return target
}

/** 追加（保持既有子节点）。 */
export function append(target, value) {
    if (!target) return target
    target.append(...toNodes(value))
    return target
}

/** 安全文本赋值（null/undefined → ''）。 */
export function setText(node, value) {
    if (!node) return node
    node.textContent = value === null || value === undefined ? '' : String(value)
    return node
}

/** 安全属性赋值（null/undefined → 移除属性）。 */
export function setAttr(node, name, value) {
    if (!node) return node
    if (value === null || value === undefined) node.removeAttribute(name)
    else node.setAttribute(name, String(value))
    return node
}

/**
 * DOM API 构造元素（数据不经字符串）。
 * @param {string} tag
 * @param {{text?:*, class?:string, attrs?:object, dataset?:object, on?:object, props?:object}} [opts]
 * @param {Array} [children]
 */
export function el(tag, opts = {}, children = []) {
    const node = document.createElement(tag)
    if (opts.class) node.className = opts.class
    setText(node, opts.text)
    for (const [k, v] of Object.entries(opts.attrs || {})) setAttr(node, k, v)
    for (const [k, v] of Object.entries(opts.dataset || {})) setAttr(node, `data-${k}`, v)
    for (const [k, v] of Object.entries(opts.props || {})) { node[k] = v }
    for (const [type, handler] of Object.entries(opts.on || {})) node.addEventListener(type, handler)
    for (const child of toNodes(children)) node.appendChild(child)
    return node
}

export default { html, mount, append, toNodes, setText, setAttr, el, SafeFragment, isSafeFragment }
