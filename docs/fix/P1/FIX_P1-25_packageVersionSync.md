# FIX-P1-25：两套 package.json 依赖版本不同步，开发与生产环境行为存在差异

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-25` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `/package.json`, `/package-lock.json` |
| **预估工时** | 1h |
| **关联问题** | P0-10（根目录 package.json 缺少 type:module 及 Prisma 依赖） |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01 |

---

## 1. 问题

> 来自 FIX_PLAN.md P1-25 原始描述：
> 两套 package.json 依赖版本不同步，开发与生产环境行为存在差异

> 来自 RG_03b_ISSUES_P1.md §3 P1-25 审阅细化：
> - **位置**：`/package.json` vs `backend/package.json`
> - **问题**：`express`（`^4.18.2` vs `^4.22.1`）、`dotenv`（`^16.0.3` vs `^16.6.1`）、`cors`（`^2.8.5` vs `^2.8.6`）、`jsonwebtoken`（`^9.0.0` vs `^9.0.2`）版本均存在差异；`nodemon` 与 `node --watch` 混用
> - **修复建议**：统一依赖版本；明确 `backend/package.json` 为唯一生产部署入口

## 2. 根因

项目存在两套 `package.json`：

- `/package.json`（根）：作为开发/测试聚合入口，含 jest/cypress/eslint/prettier/webpack/babel 等开发工具链，同时声明了与后端运行时相同的 5 个生产依赖（bcryptjs/cors/dotenv/express/jsonwebtoken），`start` 脚本为 `cd backend && npm start`（生产实际走 backend）。
- `backend/package.json`：唯一生产部署入口，含 `@prisma/client`/`prisma`，`start` 为 `node server.js`、`dev` 为 `node --watch server.js`。

根因：两套清单各自维护依赖版本，未建立同步机制，导致：

- `express`（4.18 vs 4.22）、`dotenv`（16.0 vs 16.6）、`cors`（2.8.5 vs 2.8.6）、`jsonwebtoken`（9.0 vs 9.0.2）4 项运行时依赖版本范围不一致。开发环境（根目录 `npm install`）与生产环境（`backend/` 目录 `npm install`）解析到的具体版本可能不同，存在"开发正常生产异常"的漂移风险。
- `dev` 脚本工具混用：根用 `nodemon backend/server.js`，backend 用 `node --watch server.js`，两套文件监听重启机制并存，维护认知负担。
- `bcryptjs`（`^2.4.3`）两端一致，无差异。

## 3. 修复

按 RG_03b 审阅建议"统一依赖版本；明确 `backend/package.json` 为唯一生产部署入口"，以 `backend/package.json` 为准（生产入口），最小改动 `/package.json` 两处：

**① 4 个依赖版本对齐 backend（`/package.json` dependencies 块）：**

| 依赖 | 修复前（根） | 修复后（根） | backend（基准） |
|------|------------|------------|---------------|
| `cors` | `^2.8.5` | `^2.8.6` | `^2.8.6` |
| `dotenv` | `^16.0.3` | `^16.6.1` | `^16.6.1` |
| `express` | `^4.18.2` | `^4.22.1` | `^4.22.1` |
| `jsonwebtoken` | `^9.0.0` | `^9.0.2` | `^9.0.2` |

`bcryptjs`（`^2.4.3`）两端已一致，未改动。

**② `dev` 脚本对齐 backend 入口（`/package.json` scripts.dev）：**

```diff
- "dev": "nodemon backend/server.js",
+ "dev": "cd backend && npm run dev",
```

与 `start` 脚本（`cd backend && npm start`）模式一致，统一由 `backend/package.json` 承担实际启动逻辑，消除 `nodemon`（根）与 `node --watch`（backend）混用。`nodemon` 暂保留于 `devDependencies`（见技术债 TD-P2-29）。

**③ `package-lock.json` 同步：**

执行 `npm install --package-lock-only` 重新解析锁文件，使根 `package-lock.json` 与更新后的版本范围声明一致，避免 `npm ci` 因 lock 与 manifest 不匹配而失败。

## 4. 功能影响

- **生产部署**：无影响。生产部署走 `backend/package.json`（`npm start` → `cd backend && npm start` → `node server.js`），本次未修改 backend 清单。
- **开发环境**：`npm run dev` 由原 `nodemon backend/server.js` 改为 `cd backend && npm run dev`（即 `node --watch server.js`），需 Node 18.11+（backend 既有 dev 脚本已假设此条件）。文件监听重启行为等价，工具统一为 Node 内置 `--watch`。
- **依赖解析**：根目录 `npm install` 将解析到与 backend 一致的 cors/dotenv/express/jsonwebtoken 版本范围，消除开发/生产版本漂移。4 项均为向后兼容的小版本升级（semver 兼容），无破坏性 API 变更。
- **测试工具链**：根 `devDependencies`（jest/cypress/eslint/prettier/webpack/babel/supertest/nodemon）未改动，测试工作流不受影响。

## 5. 验收标准

- [x] `/package.json` 的 `cors`/`dotenv`/`express`/`jsonwebtoken` 4 项版本与 `backend/package.json` 完全一致
- [x] `/package.json` `dev` 脚本改为 `cd backend && npm run dev`，与 `start` 脚本模式一致
- [x] `package-lock.json` 已通过 `npm install --package-lock-only` 同步，与 manifest 一致
- [x] `bcryptjs` 两端一致（`^2.4.3`），未引入差异
- [x] git diff 仅涉及 `/package.json` 与 `/package-lock.json` 两个文件

## 6. 回归测试要点

- [ ] 根目录 `npm install` 成功，无版本冲突
- [ ] 根目录 `npm run dev` 可正常启动后端并监听文件变更重启（需 Node 18.11+）
- [ ] 根目录 `npm start` 生产启动行为不变（走 `backend/server.js`）
- [ ] 根目录 `npm test`（jest）执行不受影响

## 7. 技术债

- **TD-P2-29**：`/package.json` `devDependencies` 中 `nodemon`（`^2.0.22`）在 `dev` 脚本改走 backend 入口后不再被任何脚本使用，成为未使用依赖；同时 `engines.node` 仍声明 `>=14.0.0`，而 backend `dev` 脚本 `node --watch` 需 Node 18.11+（稳定于 Node 20+），`engines` 字段与实际运行要求不一致。建议后续：① 评估移除 `nodemon` devDependency（确认无其他脚本/工具引用）；② 将 `engines.node` 收紧至 `>=18.11.0` 以反映 `node --watch` 的真实要求。

## 8. 备注

- 代码提交：`55f4321`（fix(P1-25): 根package.json依赖版本对齐backend，dev脚本统一走backend入口）
- `package.json` 为 JSON 清单文件不支持 `//` 行内注释，修改点在 commit message 与本文档标注，未在文件内添加 P1-25 注释。
- TD-P2-28（`AdaptiveUploadQueue._fetchLatest()` 硬编码 URL）属 P1-24 同类问题，与 P1-25 主题无关，不在本次清理范围，后续单独处理。
