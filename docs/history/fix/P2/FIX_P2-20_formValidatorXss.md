# FIX-P2-20：FormValidator 缺少 XSS 和 SQL 注入防护规则

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-20` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/utils/FormValidator.js` |
| **预估工时** | 1h |
| **关联问题** | P1-23（前后端校验规则同步） |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

前端 `FormValidator` 的校验规则集缺少 XSS 与 SQL 注入防护规则，仅做格式校验（长度、正则）。用户输入的恶意脚本片段或 SQL 注入串可通过前端校验直达后端，前端缺少第一道防线。

## 2. 根因分析

`js/utils/FormValidator.js` 的 `rules` 对象原仅含 `required`/`length`/`phone`/`email`/`url`/`date` 等格式规则，无 `xss`/`sqlInjection` 规则，与后端 `validationMiddleware` 的 `detectXss`/`detectSqlInjection` 不对齐。

## 3. 修复方案（2026-07-04 实施）

新增 `xss` 与 `sqlInjection` 两条规则，正则与后端 `validationMiddleware` 保持一致：

```javascript
// P2-20: XSS 防护规则，与后端 validationMiddleware.detectXss 保持一致
xss: (value) => {
    if (typeof value !== 'string') return null
    const xssPatterns = [
        /<script\b/gi, /javascript:/gi, /on\w+\s*=/gi,
        /<iframe/gi, /<embed/gi, /<object/gi,
        /eval\(/gi, /expression\(/gi
    ]
    return xssPatterns.some(p => p.test(value)) ? '输入包含不安全的内容' : null
},

// P2-20: SQL 注入防护规则，与后端 validationMiddleware.detectSqlInjection 保持一致
sqlInjection: (value) => {
    if (typeof value !== 'string') return null
    const sqlPatterns = [
        /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b)/gi,
        /UNION\s+SELECT/gi, /OR\s*1\s*=\s*1/gi,
        /'\s*OR\s*'1'='1/gi, /--\s*$/gi
    ]
    return sqlPatterns.some(p => p.test(value)) ? '输入包含可疑的 SQL 代码' : null
}
```

## 4. 验收标准

- [x] 新增 `xss` 规则，正则与后端 `detectXss` 一致
- [x] 新增 `sqlInjection` 规则，正则与后端 `detectSqlInjection` 一致
- [x] 命中恶意模式返回错误信息，未命中返回 null
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] 含 `<script>` 的输入触发 xss 规则
- [ ] 含 `' OR 1=1` 的输入触发 sqlInjection 规则
- [ ] 正常输入不受影响

## 6. 备注

- 与 P1-23 协同：P1-23 使后端规则集成为前端超集，P2-20 补齐前端缺失的注入防护规则，前后端防护对齐。
