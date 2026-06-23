> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§4 文档变更记录 + 附录
> **最后更新**：v0.10（2026-06-23）

---

## 7. 文档变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-06-22 | v0.1 | 初始创建，完成后端核心文件审阅 |
| 2026-06-22 | v0.2 | 新增 UserManager、idempotencyMiddleware、syncRoutes、AuthService、Router 审阅；问题总数 29 项 |
| 2026-06-22 | v0.3 | 补全完整目录树；新增 GuestAuthService、PermissionService、SessionManager、AuditLogger、NetworkHelper、main.js、seed.js、telemetry.js、.env.example 审阅；问题总数 39 项 |
| 2026-06-22 | v0.4 | 新增 Storage.js、AuditLogService、AuditLog、BackupRestore、UserManagement、ExportService、dedupe-test-records 审阅；问题总数 48 项 |
| 2026-06-22 | v0.5 | 新增 Auth.js、AdaptiveUploadQueue、Tableware、GenericTest、Pathogen、Dashboard、GuestDashboard 审阅；问题总数 56 项 |
| 2026-06-22 | v0.6 | 新增 pathogenRisk.js（✅正常）、FormValidator.js、SampleDataGenerator.js、UINotification.js（XSS风险）、UIHelper.js、index.html、login.html 审阅；核心文件覆盖率达 ~90%；新增 UINotification XSS（P2-18）、FormValidator 防护缺失（P2-20）、示例数据 ID 格式（P1-22）等；问题总数扩展至 62 项；建议转入修复方案输出阶段 |
| 2026-06-22 | v0.7 | 完整确认 Storage.js（_getHeaders 正常，P0-08 精确定位为 temp-token- 前缀伪造）和 AdaptiveUploadQueue.js（P1-19 淘汰策略确认为 FIFO）；新增 P1-24（_doRequest URL 硬编码）；问题总数 63 项 |
| 2026-06-22 | v0.8 | 新增 /package.json 和 backend/package.json 双文件审阅；确认 guest.html 文件不存在（404）；读取 docs/ 目录发现数据库路径歧义；新增 §1.9 双文件架构说明；新增 P0-10（根目录 package.json 启动崩溃风险）、P1-25（双 package.json 版本不同步）、P1-26（数据库路径歧义）、P2-21（Jest/ES Module 兼容性）、P2-22（Cypress 环境问题）；问题总数 63 → **68 项**；核心文件覆盖率 ~95%；建议正式转入修复阶段 |
| 2026-06-23 | v0.9 | P0-02 遗留补修（userRoutes.js 统一认证中间件）、P0-05 遗留补修（seed.js 移除 fallback 明文密码）核验通过；修复执行进度同步至 FIX_PLAN v1.5 |
| 2026-06-23 | v0.10 | P0-06（record_code 幂等性）、P0-08（temp-token- 前缀伪造）、P0-10（根目录 package.json）修复完成并核验通过；新增 §1.10 GitHub CDN 缓存问题解决方案（?t=时间戳强制回源）；修复执行进度同步至 FIX_PLAN v1.7；P0 完成率 80% |
