# 测试结果报告（docs/test-results/）

浏览器测试反馈数据的**权威数据始终在数据库** `public."TestCase"` / `public."TestExecution"`，
由平台超管通过 `admin-schools.html` 左侧菜单「测试报告」原生三视图（测试任务 / 问题反馈 / 问题总览）查看与填报。

## 数据来源

- 用例清单（任务定义）唯一权威源：`backend/lib/testCaseDefs.js` 的 `CASE_DEFS`。
- 执行记录：`public.TestCase`（用例/问题状态载体）+ `public.TestExecution`（追加式执行轨迹）。
- 实时接口：`GET /api/test-results/defs`（任务清单）、`/api/test-results/cases`（状态列表）、
  `/api/test-results/cases/:id/history`（复测轨迹）、`/api/test-results/summary`（实时汇总）。

## 如何查看

| 场景 | 方式 |
|---|---|
| 在线填报 / 汇总 / 收口 | 平台超管登录 `admin-schools.html` → 左侧「测试报告」 |
| 实时状态接口 | 上述 `/api/test-results/*` 端点（任意已登录账号可访问，测试场景） |

## 注意事项

- `latest/` 目录为旧「testReportSync 静态快照」产物，对应模块（test-report.html / testReportSync.js）
  已在 TR-Rewrite 重构中废弃并清理，本目录不再由系统自动生成，可安全删除。
- 证据图片运行时存储于 `backend/uploads/test-evidence/`（已加入 `.gitignore`，不入库）。
- 需要归档某一轮测试结果时，按日期另存 `TestCase`/`TestExecution` 数据快照即可（数据权威在库，无需文件归档）。
