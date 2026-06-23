> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§3 P3/DOCS 问题详情 + §4 优先级汇总
> **最后更新**：v0.10（2026-06-23）

---

## 3. 已发现问题清单（续）

### 🔵 P3 — 长期优化（规划阶段）

#### P3-01：SQLite 单文件数据库的并发与容灾限制
- **建议**：中期规划迁移至 PostgreSQL

#### P3-02：前端 `localStorage` 存储 JWT Token 存在 XSS 风险
- **建议**：后端配合实现 `httpOnly Cookie` 存储 Token

#### P3-03：缺少 API 版本控制机制
- **建议**：引入 `/api/v1/` 前缀

#### P3-04：`Attachment` 模型的 `file_path` 为本地路径，无云存储支持
- **建议**：规划接入腾讯云 COS 对象存储

#### P3-05：`syncRoutes.js` 的 `syncLog` 为内存数组，无持久化
- **建议**：同步日志写入 `SystemLog` 表

#### P3-06：`GuestAuthService` 与 `User` 认证体系完全独立，维护成本高
- **建议**：将 `guest` 合并为 `User.role` 中的一个角色，统一认证流程

#### P3-07：`Storage.js` 离线优先架构在多设备场景下存在数据冲突风险
- **建议**：引入乐观锁（`updated_at` 版本号校验）或 CRDT 策略

#### P3-08：`AdaptiveUploadQueue.js` `_isRecentlyCompleted()` 末尾轻微截断
- **v0.7 更新**：截断位于末尾 TTL 比较逻辑（`if (Date.now() - ts > this._fingerprintTTL)`），逻辑可完整推断，不影响审阅结论；如需精确确认可补充读取

#### P3-09：`pathogenRisk.js` 风险分级阈值（Ct < 20 / 20-30 / 30-35 / ≥35）未注明来源标准
- **位置**：`js/utils/pathogenRisk.js`
- **现状**：极低风险分支引用了 Kitajima et al., 2012，但高/中/低风险的 Ct 阈值未注明依据的国家标准或行业规范
- **建议**：补充阈值来源（如 GB 标准或 WHO 指南），确保符合食品安全监管要求

#### P3-10：`UIHelper.js` 的导航切换完全依赖 `data-target` 属性与 DOM ID 匹配，无路由状态管理
- **位置**：`js/utils/UIHelper.js`，`setupNavigation()`
- **问题**：页面刷新后无法恢复到上次访问的模块；浏览器前进/后退按钮无效；无法通过 URL 直接访问特定模块
- **建议**：引入 URL hash 路由（`#dashboard`、`#tableware` 等）实现状态持久化

---

## 4. 问题优先级汇总

| 优先级 | 数量 | 核心主题 |
|--------|------|----------|
| 🔴 P0 高危 | **10 项** | syncRoutes 无认证、JWT 弱密钥、认证不一致、注册无保护、seed 密码明文、快速访问绕过、temp-token 前缀伪造、record_code 幂等失效、Auth.js 编辑无权限校验、根目录 package.json 启动崩溃风险 |
| 🟠 P1 重要 | **26 项** | 路由冲突、内存幂等、两套审计机制、缓存一致性、重复数据根因、病原体权限漏洞、Auth 类名冲突、示例数据 ID 格式、前后端校验不同步、URL 硬编码、双 package.json 版本不同步、数据库路径歧义 |
| 🟡 P2 优化 | **22 项** | 限流、JSON 容错、全局暴露、CDN 完整性、UINotification XSS、FormValidator 防护缺失、Jest/ES Module 兼容性、Cypress 环境问题 |
| 🔵 P3 长期 | **10 项** | 数据库迁移、Token 安全、多设备冲突、Ct 阈值来源、URL 路由状态管理等 |
| **合计** | **68 项** | |
