# README.new.md — 更新稿说明

> 本回合的更新**已直接写入 `README.md`**（现有 README 即更新稿），未另建副本以免双源漂移。
> 下方列出相对更新前 README 的**全部有效改动**，均基于代码证据，无臆造。

## 版本号权威源

- 版本：`3.1.0` —— 证据 `package.json#version`。

## 本轮回合实际改动清单

| 位置 | 改动 | 证据 |
|---|---|---|
| 文首同步状态注记（旧第6行） | 删除"并标注尚未启用的能力"失真措辞，改为"后端洗涤剂识别排队服务已挂载启用、审计日志筛选增强等" | `server.js:311` |
| §1.1 洗涤剂识别条目（旧第48行） | 删除"⚠️ 后端 `/api/recognize` 路由**已实现但暂未在 server.js 挂载启用**…属已知待启用项"的错误断言；改为"已挂载于 `server.js:311` `app.use('/api', recognitionRoutes)`，对外暴露 `POST /api/recognize` 与 `GET /api/recognize/status/:jobId`，进程启动时 `recognitionQueue` 自动 pump" | `server.js:311`、`backend/routes/recognitionRoutes.js`、`backend/modules/recognitionQueue.js` |
| §5.11（新增） | 在 §5.10 后新增"洗涤剂比色识别（`/api/recognize`）"小节，正式列入 API 表：`POST /api/recognize`、`GET /api/recognize/status/:jobId`，权限=登录，说明队列/8MB/5分钟超时 | `backend/routes/recognitionRoutes.js` |
| 目录 | 在 §5 下补 §5.11 锚点 | 同上 |
| §10.2 当前待办 | 删除 `TD-Recognition-Mount` 条目（其前提"未挂载"已被证伪） | 同 D1 证据 |

## 未改动（经核对与代码一致）

- §1 五类检测、目标用户角色矩阵、部署形态、命名中立化
- §2 技术栈表（Node 20 / Prisma 5 / Express 4 等）
- §3 架构图与多学校隔离
- §4 数据库设计（schema.per-tenant、回收站、字段选项、频率模型）
- §5.1–§5.10（认证/session/guest/frequency/school/备份/测试上报）所有端点表
- §6 前端模块（registry 单一事实来源、SPA 分区、状态管理）
- §7 认证与权限（RBAC、JWT 双令牌、吊销、首登改密）
- §8 部署架构（Caddy/systemd/多租户路由）
- §9 安全设计（CORS 白名单、JWT 弱口令拦截、只读模式、限流）
- §11 开发环境搭建（`package.json#scripts` 命令、`engines.node>=18`）
- §12 运维手册

## 校验

- 版本号来自 `package.json#version`（权威源）✅
- 所有命令在 `package.json#scripts` 有定义 ✅
- 所有环境变量在 `server.js`/config 读取处有证据 ✅
- 所有端点回溯到 `backend/routes/*.js` 路由定义 ✅
- 无一条无证据断言；无 [需人工确认] 项进入本稿确定改写 ✅
