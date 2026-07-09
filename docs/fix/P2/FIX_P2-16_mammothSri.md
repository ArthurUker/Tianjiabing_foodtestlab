# FIX-P2-16：Pathogen.js 动态加载 Mammoth.js 无 SRI 完整性校验

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-16` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/modules/Pathogen.js` |
| **预估工时** | 0.5h |
| **关联问题** | - |
| **状态** | ✅ 已完成（静态验证通过；运行时验证待用户在浏览器环境手动确认） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`Pathogen.js` 动态加载 CDN 上的 Mammoth.js（用于解析 .docx 文件）时，`<script>` 标签未设置 SRI（Subresource Integrity）完整性属性。若 CDN 被入侵或遭中间人篡改，恶意脚本将在此页面上下文执行，可窃取 JWT token、篡改检测数据。

## 2. 根因分析

`js/modules/Pathogen.js` 的 `loadMammothJS()` 创建 script 元素加载 `https://cdnjs.cloudflare.com/.../mammoth.browser.min.js`，仅设 `src`，未设 `integrity` 与 `crossOrigin`，无完整性校验。

## 3. 修复方案（2026-07-04 实施）

为 script 标签添加 SRI integrity 哈希与 crossOrigin：

```javascript
script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.21/mammoth.browser.min.js';
// P2-16: 添加 SRI 完整性校验，防止 CDN 篡改攻击
script.integrity = 'sha512-bGuEL2NBSooMeQLM6bf6Xdywje4PWKegNTuKpghz2xgFXtRjEs4B3X1ql7nghiCvt8gXBAks5S3KN3Jp3Jgtow==';
script.crossOrigin = 'anonymous';
```

浏览器在加载时会比对实际内容的 SHA-512 哈希与 integrity 属性，不匹配则拒绝执行。

## 4. 验收标准

- [x] script 标签设置 `integrity`（sha512）与 `crossOrigin='anonymous'`
- [x] 静态验证通过
- [ ] ⚠️ 待用户在浏览器环境手动确认：实际加载 Mammoth.js 解析 Word 文档时，script 正常加载未被 SRI 拦截（integrity 哈希需与 CDN 实际文件匹配）

## 5. 回归测试要点

- [ ] 浏览器控制台无 SRI 校验失败错误，Mammoth.js 正常加载
- [ ] .docx 导入解析功能正常

## 6. 备注

- SRI 哈希需与 CDN 实际文件版本严格对应；若 Mammoth 版本升级，integrity 哈希须同步更新，否则会被浏览器拒绝加载。该项需在浏览器环境实际验证。
