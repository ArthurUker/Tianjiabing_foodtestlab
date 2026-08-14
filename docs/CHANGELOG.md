# 变更日志（CHANGELOG）

> 记录系统**近期（2026-08）开发工作**的完成情况，按功能主题归类。
> 本文件只收录"已上线/已落地"的变更；**尚未修复的待办问题**见 [`docs/fix/`](./fix/)。
> 详细架构与代码说明仍以 [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) 与根 [`README.md`](../README.md) 为准。

---

## 1. 浏览器测试报告系统（test-report）— 8 月主线工作

围绕测试人员反馈闭环，从零搭建了一套「上报 → 汇总 → 归档」的完整链路。

### 上报侧（`test-report.html`）
- 新增浏览器测试结果**在线填报工具**，测试人员无需接触代码即可反馈问题。
- 支持**测试人员姓名**填写（同账号多人区分提交），姓名必填。
- 证据支持按 bug 出现顺序**分步上传**（含"添加一步"空状态引导）。
- 统一用例编号规则 **R01~R28**，补全所有用例的 `guide` 字段（覆盖 100%），测试步骤指导**内联到网页**。
- 汇总页与上报页增加统一顶部状态栏、登录引导 / 退出功能。
- 修复：token 过期不再闪退回超管界面，登录页支持 `redirect` 回跳。

### 汇总侧（`docs/test-results/latest/`）
- 汇总报告整体重做为**玻璃态设计语言**，对齐系统视觉；卡片网格随窗口宽度自适应列数。
- `summary` 接口按 `case_id` 去重，避免汇总数 > 用例总数。
- 修复：提交人合并互相可见、收口口径与 `updated_at` 修正；汇总卡简称取「· 之后」部分，消除同名卡歧义。
- 手机端触控适配；证据图片目录统一中文 `case_id` 命名，修复图片碎裂。

### 同步机制（`backend/lib/testReportSync.js`）
- 新增测试结果 **docs 静态报告同步**（MD / HTML / JSON + 证据图片上传），提交后自动同步并重建 `dist`。
- `defs` 接口加 `no-store` 缓存头 + Caddy HTML no-cache，确保测试人员看到最新用例清单。
- `docs/test-results/latest/` 加入 `.gitignore`（覆盖式快照，不入库），`build-static` 增加缺失容错。

---

## 2. 权限与账号加固（8/13–8/14）

- **账号权限复测用例 P01~P07** 落地；访客权限加固（`guest_enabled` 开关 + 访客限流）。
- **限流计数修复**（P0-13）：修复由 NB-29 引入、持续约 18 天的 `rateLimit` 全局失效回归，全局限流/登录/访客/verify-token 等 8 处挂载点恢复生效。
- 后台调整角色后**旧 token 实时生效**；`test` 账号恢复 manager 写入/复检权限。
- 管理台新增用户置 `must_change_password=true`，首登强制改密。

---

## 3. 数据备份与恢复模块（8/10–8/11）

- **P0 数据备份引擎**：`pg_dump` 逻辑备份 + KMS/AES 信封加密 + L1 校验 + 离线验证闭环。
- **P1 运维备份控制台**：影子恢复引擎 + 恢复 API + 维护模式。

---

## 4. 洗涤剂残留自动识别（8/11）

- 前端纯 Canvas 色度算法（`js/utils/detergentColorimetry.js`）+ 演示页 + Tableware 模块接入。
- 拍照识别按钮改为按需注入/移除 DOM，消除 CSS 缓存导致的按钮残留。

---

## 5. 学校定制 jsonb 兼容修复（8/8–8/11）

- `SchoolCustomization` 的 jsonb 列写入补 `::jsonb` cast（对齐 public 历史 jsonb 列）。
- `tenantSync` 回填 `visible_types` / `visible_menu_items` / `canteens` 同样改用 `$1::jsonb`。
- `deploy.sh` RK40 列清单补全 `field_types` / `visible_menu_items` / `canteens`。

---

## 6. 缺陷修复与浏览器验证（8/8–8/12）

- **缺陷 B**：`AdaptiveUploadQueue` 409 分支释放 `_isProcessing` 并继续调度，消除队列死锁。
- **缺陷 X**：`_updateLocalCache` 新增 `forceServer`；`_applyServerRecord` 接入 `_handleUpdate`，消除 `_status`/`version` 永久陈旧。
- 餐具表格移除 `glass-table-wrap` 包裹（修复 `insertBefore` 报错）；数据看板显示为 0 修复；移除备份渲染脚本消除 401 噪音。
- 全站手机端适配；超管界面保持桌面版样式。
- 第七轮浏览器验证逐项审批（`AUDIT-EXEC` 15 项独立 commit），见 `git log --grep="AUDIT-EXEC"`。

---

## 7. 部署与构建

- Caddyfile 模板 `X-Frame-Options` 多余引号修复。
- 构建脚本拷贝列表补充 `test-report.html` 与 `detergent-image-demo.html`。
- 忽略根目录 `backups/` 下的表级 `.sql` 备份文件。

---

## 待修复问题

当前尚未修复的测试反馈问题（17 项 failed-open）见 [`docs/fix/复核报告-20260814.md`](./fix/复核报告-20260814.md)，
其中的 P0/P1 优先级清单与逐条根因定位见 [`docs/fix/待修复问题深度分析-20260814.md`](./fix/待修复问题深度分析-20260814.md)。
