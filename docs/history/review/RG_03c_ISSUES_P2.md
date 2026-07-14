> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§3 P2 优化建议详情
> **最后更新**：v0.10（2026-06-23）

---

## 3. 已发现问题清单（续）

### 🟡 P2 — 优化建议（建议 2 周内处理）

#### P2-01：`rateLimit` 默认值过高，登录接口无专项限流
- **修复建议**：`POST /api/user/login` 单独限流 10 次/分钟/IP

#### P2-02：检测记录 CRUD 操作未自动写入审计日志（后端层面）
- **修复建议**：记录 CRUD 成功响应后统一调用 `prisma.auditLog.create()`

#### P2-03：`UserManager.loginUser()` 失败登录日志未确认写入数据库
- **修复建议**：确认 `logFailedLogin` 是否写入 `AuditLog` 表

#### P2-04：`AuthService.getUser()` 对 `JSON.parse` 无容错处理
- **修复建议**：添加 try/catch，异常时调用 `clearAuth()`

#### P2-05：`Router.init()` 每次调用都实例化新的 `GuestAuthService`
- **修复建议**：构造函数中初始化单例

#### P2-06：`/api/health` 与 `/health` 重复定义
- **修复建议**：统一保留 `/api/health`

#### P2-07：`buildRecordWriteData()` 字段提取无 Schema 验证
- **修复建议**：引入 Zod 或 Joi 进行请求体 Schema 验证

#### P2-08：`Backup` 模型缺少关联用户外键约束
- **修复建议**：添加 `created_user User? @relation(...)` 关联

#### P2-09：`NetworkHelper.checkConnection()` 硬编码 Google URL，内网环境不可达
- **修复建议**：改为检查自身后端健康接口 `/api/health`

#### P2-10：`main.js` 和 `Dashboard.js` 大量函数通过 `window.*` 全局暴露
- **修复建议**：使用自定义事件（`CustomEvent`）替代全局函数调用

#### P2-11：`GuestAuthService.getCurrentGuest()` 对 `JSON.parse` 无容错处理
- **修复建议**：添加 try/catch

#### P2-12：`seed.js` 中测试账号在生产环境应禁用
- **修复建议**：通过 `NODE_ENV` 判断，生产环境仅创建 admin 账号

#### P2-13：`Storage.js` 的 `tempId` 使用 `Date.now()` + `Math.random()`，多标签页可能碰撞
- **修复建议**：使用 `crypto.randomUUID()` 生成 tempId；增加僵尸记录清理机制

#### P2-14：`ExportService.js` 导出数据完全来自本地缓存，可能导出过期数据
- **修复建议**：导出前调用强制同步，或直接从后端 API 拉取数据

#### P2-15：`AuditLogService.getStats()` 调用路径与 P1-01 路由冲突
- **修复建议**：修复 P1-01 路由顺序后，此问题自动解决

#### P2-16：`Pathogen.js` 通过动态 `<script>` 从 CDN 加载 Mammoth.js，无 SRI 完整性校验
- **修复建议**：添加 `script.integrity = 'sha384-...'` 和 `script.crossOrigin = 'anonymous'`；或将 Mammoth.js 本地化

#### P2-17：`GenericTest.js` 作为基类但各检测模块未通过继承复用，存在大量重复代码
- **修复建议**：将 `Tableware.js`、`Pathogen.js` 等重构为继承 `GenericTestModule` 的子类

#### P2-18：`UINotification.show()` 使用 `innerHTML` 直接插入 `message` 参数，存在 XSS 风险
- **位置**：`js/utils/UINotification.js`，`show()` 方法
- **代码**：`notification.innerHTML = \`...<div class="flex-1">${message}</div>...\``
- **问题**：
  - `message` 参数若包含用户输入内容（如检测员姓名、样本备注等），会被直接插入 DOM
  - 攻击者可通过构造恶意检测记录（如 `<img src=x onerror=alert(1)>`），在其他用户查看通知时触发 XSS
  - `UINotification` 被系统中几乎所有模块调用，攻击面极广
- **修复建议**：
  ```js
  // 将 innerHTML 改为 textContent 或使用 DOMPurify 净化
  const msgEl = document.createElement('div')
  msgEl.className = 'flex-1'
  msgEl.textContent = message  // 安全：自动转义 HTML
  notification.appendChild(msgEl)
  ```
  或引入 `DOMPurify.sanitize(message)` 进行净化

#### P2-19：`login.html` 中"以访客身份进入"按钮缺少权限说明，用户可能误解其访问范围
- **位置**：`login.html`
- **问题**：按钮描述为"访客只读模式，可查看所有检测数据"，但实际快速访问模式下病原体模块也可访问（P1-18），描述与实际不符；且无任何关于数据安全或隐私的提示
- **修复建议**：修复 P1-18 后更新描述；添加访客访问范围的明确说明

#### P2-20：`FormValidator.js` 缺少 XSS/注入防护规则，与后端安全校验不形成闭环
- **位置**：`js/utils/FormValidator.js`
- **问题**：规则库包含 `required`、`email`、`phone`、`idCard` 等业务规则，但缺少：
  - HTML 特殊字符转义（`<`, `>`, `"`, `'`, `&`）
  - SQL 注入特征检测（`'`, `--`, `;`）
  - 脚本注入检测（`<script>`, `javascript:`）
- **修复建议**：添加 `noHtml` 和 `noScript` 验证规则；与后端 `validationMiddleware.js` 的 `escapeHtml` 逻辑对齐

#### P2-21：Jest 测试框架与 ES Module 后端代码兼容性未验证（v0.8 新增）
- **位置**：根目录 `package.json` + `.babelrc`
- **问题**：Jest 默认不支持 ES Module，需要 Babel 转译；当前 `.babelrc` 配置是否完整覆盖后端代码未确认；`test:backend` 脚本使用 glob 模式在 Windows 环境下行为与 Linux 不同，可能导致测试文件找不到
- **修复建议**：在 `jest.config.js` 中添加 `transform` 配置，或改用 `--experimental-vm-modules` 运行 Jest

#### P2-22：Cypress E2E 测试脚本在 Windows Server 生产环境无法运行（v0.8 新增）
- **位置**：根目录 `package.json`，`test:e2e` 系列脚本
- **问题**：腾讯云 Windows Server 无 headless 浏览器环境，`cypress run` 会直接失败
- **修复建议**：E2E 测试仅在本地开发环境运行；CI/CD 流程中跳过 Cypress；或改用 Playwright headless 模式
