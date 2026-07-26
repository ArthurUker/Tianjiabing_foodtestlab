# DS-18 依赖 CVE 审计与升级记录

日期：2026-07-26　分支：`fix/frontend-security`　Node：v24.15.0 / npm 11.12.1

## 审计结论

- **backend/（生产运行时）**：`npm audit` → **0 vulnerabilities**。
  `express@^4.22.1`、`@prisma/client@^5.10.0`、`jsonwebtoken@^9.0.2`、`bcryptjs@^2.4.3`、`cors`、`dotenv` 均无已知中高危 CVE，未做改动。
- **根目录（前端/测试工具链）**：漏洞全部集中在 **devDependencies**，不进入生产产物。

## 已升级（根 package.json devDependencies）

| 包 | 旧版本 | 新版本 | 消除的公告 |
| --- | --- | --- | --- |
| cypress | ^12.11.0 | 15.19.0 | GHSA-p8p7-x288-28g6（@cypress/request SSRF, critical）、GHSA-fjxv-7rqg-78g4 / GHSA-hmw2-7cc7-3qxx（form-data, critical）、GHSA-w7fw-mjwx-w883 / GHSA-6rw7-vpxm-498p（qs DoS, moderate）、GHSA-w5hq-g745-h8pq（uuid, moderate） |
| nodemon | ^2.0.22 | 3.1.14 | GHSA-c2qf-rxjj-qqgw（semver ReDoS, high，经 simple-update-notifier 链） |

验证：`npm run build` 通过；`npx eslint --version`、`npx jest tests/smoke.test.js`（3 passed）均正常。
注意：本次以 `CYPRESS_INSTALL_BINARY=0` 安装，首次跑 e2e 前需执行 `npx cypress install` 下载 15.x 二进制。

## 记录豁免（暂不修复）

- **brace-expansion <=5.0.7 — GHSA-mh99-v99m-4gvg（high，OOM DoS）**，剩余 26 条 high 全部为该单一公告在依赖树中的重复计数。
  - 引入链：`eslint@8` / `jest@29` / `babel` 等 → `minimatch@3/9` → `brace-expansion@1/2`，**全部为 devDependencies**，不随前端静态产物或后端部署发布，攻击面仅限本地开发/CI 对恶意 glob 模式的处理，实际风险极低。
  - 唯一修复版本为 `brace-expansion@5.0.8`：已实测通过 npm `overrides` 强制后 **CJS 导出形态不兼容 minimatch v3**（`TypeError: e is not a function`，会直接打挂 eslint/jest），且要求 Node ≥20，故回退。
  - 彻底修复路径：升级 `eslint@10` + `jest` 新版（破坏性升级，超出本窗口范围），待后续专项处理。
