# 文档中心（docs/README.md）

田家炳食品检验系统（部署代号 `foodtestlab`）的文档入口。

> 本目录文档基于**当前仓库实际代码**维护。旧版过程记录与历史说明已统一归档至 [`history/`](./history/)，仅供追溯参考，不再作为权威文档。

## 必读

- **[系统总览 README.md（根）](../README.md)** —— 项目一级入口：业务定位、架构图、API、认证权限、部署、安全、运维一页纸。第一次接触项目从这里开始。
- **[开发文档 DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md)** —— 系统总览、技术栈、目录结构、后端架构与 API、前端架构、数据库、部署、测试、已知偏差。新接手或改动代码前先读。
- **[项目操作规范 PROJECT_CONVENTIONS.md](./PROJECT_CONVENTIONS.md)** —— 长期生效规范（审计日志保留原则、方法偏离预先报备原则，**优先级最高**）。涉及审计日志 / 方法选型的任何操作都必须先遵守。

## 关联说明

- 部署：[`deploy/README.md`](../deploy/README.md)
- 后端：[`backend/README.md`](../backend/README.md)

## 归档说明

`docs/history/` 下的旧文档（原 `fix/`、`review/`、`dev/`、`deploy-templates/` 及各顶层文档）为历史修复 / 评审 / 设计记录。当前代码已完成历史修复任务（项目修复完成度 100%），这些记录仅保留作演进追溯，其描述的部署形态（如 Windows/Nginx/PM2/珠海一中）已不再是当前实际方案，请以 `DEVELOPMENT_GUIDE.md` 为准。

## 目录约定

| 路径 | 性质 | 是否随会话失效 |
|------|------|----------------|
| `docs/DEVELOPMENT_GUIDE.md` | 权威开发文档（随代码更新） | 否 |
| `docs/PROJECT_CONVENTIONS.md` | 长期操作规范 | 否（最高优先） |
| `docs/history/` | 历史归档（只读参考） | 否 |
