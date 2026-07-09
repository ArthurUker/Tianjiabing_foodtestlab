# FIX-P2-18：UINotification.show() 使用 innerHTML 存在 XSS 风险

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-18` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/utils/UINotification.js` |
| **预估工时** | 0.5h |
| **关联问题** | - |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`UINotification.show(message)` 通过 `innerHTML` 拼接 message 内容。若 message 含用户可控数据（如检测样本名、错误信息中包含用户输入），HTML 会被解析执行，构成 XSS。

## 2. 根因分析

`js/utils/UINotification.js` 的 `show()` 原使用 `notification.innerHTML = ...${message}...` 模板拼接，未对 message 转义，动态文本直接进入 HTML 上下文。

## 3. 修复方案（2026-07-04 实施）

改用 DOM API 构建结构 + `textContent` 注入动态文本：

```javascript
// P2-18: 使用 DOM API + textContent 构建，避免 innerHTML 导致的 XSS 风险
const icon = document.createElement('i')
icon.className = `fas ${this.getIcon(type)} text-lg`

const content = document.createElement('div')
content.className = 'flex-1'
content.textContent = message   // textContent 不解析 HTML，天然防 XSS

const closeBtn = document.createElement('button')
closeBtn.textContent = '×'

notification.appendChild(icon)
notification.appendChild(content)
notification.appendChild(closeBtn)
```

对于必须用 innerHTML 的静态结构（如带 spinner 的确认框），仅 innerHTML 写入静态安全模板，动态文本一律走 `textContent`/DOM API。

## 4. 验收标准

- [x] `show()` 的 message 经 `textContent` 注入，不解析 HTML
- [x] 含 `<script>` 标签的 message 以纯文本显示，不执行
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] 传入 `message = '<img src=x onerror=alert(1)>'` → 纯文本显示，无弹窗

## 6. 备注

> 无。
