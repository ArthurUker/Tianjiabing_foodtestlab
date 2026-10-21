# 变更日志（CHANGELOG）

> 记录系统**近期（2026-08）开发工作**的完成情况，按功能主题归类。
> 本文件只收录"已上线/已落地"的变更；**尚未修复的待办问题**见 [`docs/fix/`](./fix/)。
> 详细架构与代码说明仍以 [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) 与根 [`README.md`](../README.md) 为准。

---

## 1. 浏览器测试报告系统（测试报告模块）— 8 月主线工作

围绕测试人员反馈闭环，从零搭建了一套「上报 → 汇总 → 归档」的完整链路。

> 注：本功能最初以独立页 `test-report.html` + 静态同步引擎 `testReportSync.js` 实现，
> 后在 TR-Rewrite 重构中并入平台超管控制台原生三视图（`admin-schools.html` 左侧「测试报告」），
> 旧独立页与同步引擎已废弃并清理。以下为当时落地能力的叙述。

### 上报侧（现：admin-schools.html 测试报告模块）
- 新增浏览器测试结果**在线填报工具**，测试人员无需接触代码即可反馈问题。
- 支持**测试人员姓名**填写（同账号多人区分提交），姓名必填。
- 证据支持按 bug 出现顺序**分步上传**（含"添加一步"空状态引导）。
- 统一用例编号规则 **R01~R28**，补全所有用例的 `guide` 字段（覆盖 100%），测试步骤指导**内联到网页**。
- 汇总页与上报页增加统一顶部状态栏、登录引导 / 退出功能。
- 修复：token 过期不再闪退回超管界面，登录页支持 `redirect` 回跳。

### 汇总侧（现：测试报告「问题总览」视图）
- 汇总报告整体重做为**玻璃态设计语言**，对齐系统视觉；卡片网格随窗口宽度自适应列数。
- `summary` 接口按 `case_id` 去重，避免汇总数 > 用例总数。
- 修复：提交人合并互相可见、收口口径与 `updated_at` 修正；汇总卡简称取「· 之后」部分，消除同名卡歧义。
- 手机端触控适配；证据图片目录统一中文 `case_id` 命名，修复图片碎裂。

### 同步机制（已废弃：testReportSync.js）
- 原测试结果 **docs 静态报告同步**（MD / HTML / JSON + 证据图片上传）能力，现由控制台原生视图 + 数据库权威存储取代。
- `defs` 接口加 `no-store` 缓存头 + Caddy HTML no-cache，确保测试人员看到最新用例清单。
- `docs/test-results/latest/` 为旧产物目录，已不再由系统生成，可安全删除。

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

- 基于 OpenCV.js（WASM）的 ArUco 定位 + 单应校正 + ΔE2000 比色，前后端共用 `js/opencv/recognizer.js`；演示页与 Tableware 模块接入。
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
- 构建脚本拷贝列表补充 `detergent-image-demo.html`（测试报告模块已并入 admin-schools.html，独立页 test-report.html 已废弃）。
- 忽略根目录 `backups/` 下的表级 `.sql` 备份文件。

---

## 8. 胶体金照片录入与识别（2026-10-19 / 10-20）

- 新增农残、肉蛋点位的照片录入：复用原「检测结果」下拉，增加「上传照片识别」「拍照识别」；识别结果回填后仍走原保存按钮，手工录入链路不变。
- 瘦肉精三联：一次实体卡对应三条项目记录，共享同一原始照片；三联隐藏单一「检测结果」字段，改为三个通道下拉 + 两个识别按钮。
- 自动识别失败不产生合格性结论；转手工时保留失败尝试、原图与来源（`manual_after_auto_failure`）。
- 原图只保存上传原文件，落盘到数据盘 `COLLOIDAL_PHOTO_DIR`（0700），留存天数未设置、无自动删除任务；记录详情可按权限查看原图与识别过程。
- **识别方式：2026-10-20 起由浏览器 WASM 改为服务端常驻进程**（Node 队列 + `backend/recognizer/worker.py`，并发 1、队列 50、超时 90s、失败重试 1 次，不监听端口）。浏览器端 `reader.worker.js` 与约 41 MiB 运行时已移除，`dist` 由 60 MB 降至 18 MB；单张识别约 0.5–1 秒（此前冷启动 50–70 秒）。
- 新增 `GET /api/colloidal/recognition`（manager/admin）查看队列状态；`scripts/install-colloidal-recognizer.sh` 安装服务端运行时。
- 修复：保存后列表不刷新（服务端建单结果立即并入本地缓存）；补填检测员后重复建单；识别前必须先填检测员的死锁。
- 新增：检测员默认值——按「学校 + 账号」记住上次输入，五个录入模块共用（仅本地存储，不上传）。

## 9. 移动端适配与 iOS 兼容（2026-10-21）

- 新增 `frontend/css/mobile.css`（仅 ≤768px 生效，`index.html` / `login.html` 均引入）：正文控件 ≥46px、输入 16px（避免 iOS 聚焦放大）、弹层限高内部滚动、提示条改底部通栏、分页 40px、登录页 48px 控件与 12px 外边距、刘海屏安全区。
- 新增 `frontend/js/utils/responsiveTables.js`：记录表在窄屏转为带字段名的卡片（`data-label`），桌面端表格结构不变。
- 修复手机端侧边抽屉选中模块后不收起（导航按钮自身 `stopPropagation`，改为捕获阶段监听），并加背景滚动锁、ESC/遮罩/窗口变宽自动关闭。
- 修复 iOS 上「上传照片识别 / 拍照识别」点击无反应：文件输入曾用 `hidden`（`display:none`），WebKit 会忽略其 `click()`；改为视觉隐藏类 `.colloidal-file-input`，`accept` 放宽为 `image/*`；iOS 从下拉触发时额外提供「轻触选择照片 / 轻触打开相机」真实按钮（`select` 的 change 在 iOS 上不构成用户手势）。
- 修复 iOS「检测日期」输入框撑出卡片：日期/时间输入统一 `min-width:0; max-width:100%; box-sizing:border-box`，手机端 `-webkit-appearance:none` 统一外观，并对 iOS 补 `showPicker()` 兜底；表单网格子项加 `min-width:0`。
- 校验：320/360/390 三档宽度下页面无横向溢出、无小于 38px 的触控目标；桌面 1440 与平板 820 不受影响。

## 待修复问题

当前尚未修复的测试反馈问题（17 项 failed-open）见 [`docs/fix/复核报告-20260814.md`](./fix/复核报告-20260814.md)，
其中的 P0/P1 优先级清单与逐条根因定位见 [`docs/fix/待修复问题深度分析-20260814.md`](./fix/待修复问题深度分析-20260814.md)。
