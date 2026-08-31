# README_REVIEW.md — 人工复核清单

> 🗄️ **已归档（2026-08-31）**：本文件是 2026-08-24 的一次性人工复核清单，结论已并入根目录 `README.md`，
> 并从仓库根目录移入 `docs/archive/`。**其中部分口径已过时**（例如复核命令里的后端端口 `3000`，生产实为 **3002**）。
> **以根目录 `README.md` 为唯一权威文档**，本文件仅供过程追溯。

> 生成日期：2026-08-24
> 本稿**未替代人工运行验证**。以下清单供接手者在干净环境中逐项确认。

## 一、本轮已修正（需人工二次确认）

| 项 | 修正内容 | 复核建议 |
|---|---|---|
| R1 | 删除 README 中"后端 `/api/recognize` 未挂载启用"的断言，改为已挂载（`server.js:311`） | 在运行实例执行 `curl -F image=@x.jpg http://127.0.0.1:3000/api/recognize`，确认返回 `jobId`（需登录 token） |
| R2 | 新增 §5.11 文档化 `/api/recognize`、`/api/recognize/status/:jobId` | 核对端点路径、字段名（`image` multipart）、8MB 限制、`JOB_TIMEOUT_MS` 5 分钟超时是否与 `recognitionQueue.js` 一致 |
| R3 | 删除 §10.2 `TD-Recognition-Mount` 待办 | 确认该待办确已无意义（路由已启用） |

## 二、高风险差异复核

- **D1/D2（已修正，原高风险）**：上一轮更新错误地声称后端识别路由未挂载。本轮以 `server.js:311` 为据已更正。**请人工确认 `server.js` 当前 HEAD 确实含该 `app.use` 行**，避免工作区未提交改动导致文档与运行实例不符。

## 三、常规人工复核清单（命令/环境/端点/License/badge）

- [ ] **命令可执行性**：`npm start` / `npm run dev` / `npm run build` / `npm test` 等是否能在干净 `npm install` 后跑通（`package.json#scripts` 已定义，但未实跑验证）。
- [ ] **端点文档完整性**：§5 各小节端点是否与实际路由逐一对应（本轮回合已核对 recognition/frequency/audit/guest/backup，建议补跑 `grep -rn "router\.(get|post|put|delete|patch)" backend/routes` 全量比对）。
- [ ] **环境变量遗漏检查**：README §8.4/§11 环境变量表是否覆盖全部 `process.env.*` 读取点。建议脚本化抽取 `server.js`+`lib`+`config` 中 `process.env.X` 并与文档表 diff。
- [ ] **License**：README 未声明 License 章节，仓库亦未见 `LICENSE` 文件 —— **[需人工确认]** 是否应补充（私有仓库可标注"内部专有，未开源"）。
- [ ] **badge/CI**：仅存在 `.github/workflows/guard-client-branch.yml`（保护 `deploy/**` 分支），README 未引用任何 badge —— 无失效 badge 风险，但 **[需人工确认]** 是否需补充 CI 状态徽章。
- [ ] **Node 版本表述**：`package.json#engines.node=">=18.0.0"`，而 §2 写"Node.js 20（NVM）"。建议统一：运行时推荐 20，最低要求 18，避免读者混淆 **[需人工确认]** 是否调整措辞。
- [ ] **版本号同步**：README 标注 `3.1.0` 与 `package.json#version` 一致；下个发版需同步更新两处。

## 四、声明

本稿基于已提交代码静态分析，未执行 `npm install`、未启动服务、未实跑任何命令。**所有"一致"判定为代码静态比对结论，不等于运行验证通过**。上线/对外发布前请完成上述清单的实跑复核。
