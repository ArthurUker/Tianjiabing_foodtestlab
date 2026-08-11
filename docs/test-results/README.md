# 测试结果报告（docs/test-results/）

浏览器测试反馈数据的**整理后呈现目录**。权威数据始终在数据库 `public."TestResult"`，
本目录是同步引擎（`backend/lib/testReportSync.js`）自动生成的静态快照，便于直接查看。

## 目录结构

```
docs/test-results/
├── README.md            ← 本说明
└── latest/              ← 最新同步快照（每次有新提交即覆盖刷新）
    ├── index.html       ← 交互式报告：汇总卡 + 按 分组/结果/提交人 筛选 + 图片点击放大（浏览器打开）
    ├── REPORT.md        ← Markdown 报告：GitHub / IDE 直接渲染，图片用相对路径内嵌
    ├── snapshot.json    ← 结构化数据快照（程序可读，含每组每用例全部字段）
    └── evidence/        ← 证据图片副本（由 backend/uploads/test-evidence/ 复制而来，按用例分目录）
```

## 如何查看

| 场景 | 方式 |
|---|---|
| 看交互报告（推荐） | 浏览器打开 `docs/test-results/latest/index.html` |
| GitHub / IDE 里看 | 直接打开 `docs/test-results/latest/REPORT.md` |
| 程序读取 | 解析 `docs/test-results/latest/snapshot.json` |
| 实时在线看 | `http://111.231.166.161:8080/test-report.html`（登录后顶部汇总卡 + 用例回填） |

## 何时更新

- **自动**：测试人员每次在 `test-report.html` 点「保存」后，后端异步重新生成本目录（可
  用环境变量 `TEST_REPORT_DOCS_SYNC=false` 关闭）。
- **手动**：`node scripts/sync-test-results-docs.mjs`（需可连数据库）。

## 注意事项

- `latest/` 是**覆盖式**快照，不保留历史；需要归档某一轮结果时，把整个
  `docs/test-results/latest/` 复制为带日期的目录（如 `docs/test-results/2026-08-11/`）再提交 git。
- 服务器 git 部署（`deploy.sh` 的 `git fetch + reset`）会还原本目录到仓库版本，因此
  **归档需手动 `git add docs/test-results` 提交**，不要把同步产物当作唯一的持久化存储。
- 图片运行时存储于 `backend/uploads/test-evidence/`（已加入 `.gitignore`，不入库）；
  `docs/test-results/latest/evidence/` 里的副本在下次同步时按数据库引用重建。
