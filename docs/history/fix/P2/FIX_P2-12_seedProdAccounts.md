# FIX-P2-12：seed.js 测试账号在生产环境应禁用

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-12` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `backend/prisma/seed.js` |
| **预估工时** | 0.5h |
| **关联问题** | P0-05（seed 初始密码明文） |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`seed.js` 创建 admin/operator/viewer 三个测试账号。若生产环境误执行 seed，会植入测试账号（即便密码已改为从环境变量读取），存在默认凭据暴露风险。

## 2. 根因分析

`backend/prisma/seed.js` 无环境判断，任何环境执行 `prisma db seed` 都会创建测试账号，缺乏生产环境保护。

## 3. 修复方案（2026-07-04 实施）

在 seed 入口增加生产环境守卫，默认禁止生产环境创建测试账号，须显式设置 `SEED_ALLOW_PROD=true` 才放行：

```javascript
// P2-12: 生产环境默认禁止创建测试账号，防止默认凭据泄露风险
// 如需在生产环境初始化，须显式设置 SEED_ALLOW_PROD=true
if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PROD !== 'true') {
  console.warn('[SKIP] 生产环境检测到 (NODE_ENV=production)，已跳过测试账号初始化。')
  console.warn('[SKIP] 如确需在生产环境创建初始账号，请设置 SEED_ALLOW_PROD=true 后重新执行。')
  await prisma.$disconnect()
  process.exit(0)
}
```

同时 seed 已要求 `SEED_ADMIN_PASSWORD`/`SEED_OPERATOR_PASSWORD`/`SEED_VIEWER_PASSWORD` 三个环境变量全部配置（P0-05 修复），缺失即 `process.exit(1)`。

## 4. 验收标准

- [x] `NODE_ENV=production` 且未设 `SEED_ALLOW_PROD` → seed 跳过并退出（exit 0）
- [x] `SEED_ALLOW_PROD=true` 时放行
- [x] 开发环境不受影响
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] 生产环境执行 seed → 输出 [SKIP] 并退出，不创建账号
- [ ] 设置 SEED_ALLOW_PROD=true 后可正常创建

## 6. 备注

- 与 P0-05 协同：P0-05 移除了明文密码 fallback 并要求环境变量配置，P2-12 在此基础上增加生产环境守卫，双重防护。
