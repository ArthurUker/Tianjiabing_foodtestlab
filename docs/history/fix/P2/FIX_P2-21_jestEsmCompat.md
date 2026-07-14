# FIX-P2-21：Jest 测试框架与 ES Module 代码兼容性未验证

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-21` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `jest.config.cjs`（新增）、`tests/smoke.test.js`（新增）、`.babelrc`（既有，复用 env.test） |
| **预估工时** | 1h |
| **关联问题** | P2-22（Cypress E2E 骨架） |
| **状态** | ✅ 已完成（`npx jest` 实跑 6/6 通过） |
| **完成日期** | 2026-07-10 |

---

## 1. 问题描述

项目 `package.json` 声明 `"type": "module"`（ESM），源码全部使用 `import/export`。此前仓库内无任何 `*.test.js` 测试文件，也无 Jest 配置，Jest 能否正确加载并执行 ESM 源码从未被验证。

## 2. 根因分析

Jest 默认在 CommonJS 运行时下执行，直接 `import` ESM 源码会报 `Cannot use import statement outside a module`。项目已安装 `babel-jest` 与 `@babel/preset-env`，且 `.babelrc` 含 `env.test` preset（`targets.node=current`），具备将 ESM 转译为 CJS 的能力，但缺少 Jest 配置将二者接通，且无测试用例做兼容性冒烟验证。

## 3. 修复方案（2026-07-10 实施）

1. 新增 `jest.config.cjs`（因 `type:module`，配置用 `.cjs` 后缀以便 Node 正确解析）：
   - `testEnvironment: 'jsdom'`（前端模块兼容）
   - `transform: { '^.+\\.js$': 'babel-jest' }`（经 `.babelrc` 转译 ESM）
   - `testMatch: ['**/tests/**/*.test.js']`
2. 新增 `tests/smoke.test.js`，通过 `import` 加载两个零依赖纯函数模块（`js/utils/Validator.js`、`js/utils/pathogenRisk.js`）并断言其行为，验证 ESM 导入 + 转译 + 执行链路。

## 4. 验收标准

- [x] 新增 Jest 配置，babel-jest 接通 `.babelrc`
- [x] 冒烟测试通过 `import` 加载 ESM 源码
- [x] `npx jest tests/smoke.test.js` 实跑通过（**6/6 passed**）
- [x] 确认 Jest + ESM 兼容

## 5. 回归测试要点

- [ ] 后续新增测试沿用 `tests/**/*.test.js` 命名即可被自动发现
- [ ] 需要 DOM 的前端模块可直接在 jsdom 环境测试

## 6. 备注

- 本项属测试基础设施建设，非业务代码缺陷修复。
- 冒烟测试选取零依赖纯函数模块，避免网络/DOM/存储副作用干扰兼容性结论。
