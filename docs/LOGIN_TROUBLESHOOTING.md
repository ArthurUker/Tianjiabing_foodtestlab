# 🔐 登录失败问题解决方案

## 问题描述

系统 Cypress 测试显示登录失败，错误信息为：
```
✗ 登录失败：用户不存在或密码错误
```

## 🎯 根本原因

1. **测试用户不存在**: Cypress 测试使用 `testuser@example.com`，但此用户在数据库中不存在
2. **缺少数据初始化**: 数据库没有为测试创建相应的用户账号
3. **环境配置不完整**: 未在服务器启动时初始化测试数据

## ✅ 解决方案

本项目已提供完整的解决方案，包括：

### 1. 自动测试用户创建
- **文件**: `backend/config/testDataInitializer.js`
- **功能**: 服务器启动时自动创建 3 个测试用户
- **触发条件**: 非生产环境（NODE_ENV !== 'production'）

### 2. 数据库初始化脚本
- **SQL 脚本**: `backend/sql/02_seed_test_users.sql`
- **用途**: 手动创建测试用户（可选）
- **命令**: 在 Supabase SQL Editor 中运行

### 3. 改进的登录错误处理
- **登录页面**: 更好的错误提示和调试信息
- **前端验证**: 立即显示验证错误
- **用户指导**: 清晰的账号信息和问题排查提示

## 🚀 快速开始

### 方案 A: 自动初始化（推荐）

**第 1 步**: 启动后端服务
```bash
cd backend
npm start
```

**预期输出**:
```
✅ API Server is running on port 3000
🔧 开始初始化测试用户...
✅ 测试用户创建成功: testuser (testuser@example.com)
✅ 测试用户创建成功: qa_tester (qa@example.com)
✅ 测试用户创建成功: disabled_user (disabled@example.com)
✅ 测试用户初始化完成，新建 3 个用户
```

**第 2 步**: 使用测试账号登录
```
用户名: testuser
密码: TestPass123!
```

### 方案 B: 手动初始化（用于数据库重置）

**第 1 步**: 在 Supabase SQL Editor 中运行
```sql
-- 复制 backend/sql/02_seed_test_users.sql 的内容到 SQL Editor
```

**第 2 步**: 启动后端服务
```bash
npm start
```

## 📝 可用的测试账号

| 用户名 | 邮箱 | 密码 | 用途 |
|--------|------|------|------|
| testuser | testuser@example.com | TestPass123! | E2E 测试 |
| qa_tester | qa@example.com | TestPass123! | QA 测试 |
| disabled_user | disabled@example.com | TestPass123! | 禁用状态测试 |

## 🧪 运行 Cypress 测试

```bash
# 启动 Cypress UI
npm run cypress:open

# 或运行测试
npm run cypress:run

# 只运行登录测试
npm run cypress:run -- --spec "cypress/e2e/auth.cy.js"
```

## 🔍 故障排查

### 症状: "用户不存在或密码错误"

**可能原因** | **解决方案**
---|---
后端未启动 | 运行 `cd backend && npm start`
测试用户未创建 | 检查后端日志中的 "✅ 测试用户创建成功"
数据库连接失败 | 检查 `.env` 中的 SUPABASE_URL 和 SUPABASE_KEY
密码不正确 | 使用 `TestPass123!` （注意大小写）

### 症状: 登录成功但立即重定向回登录页

**检查清单**:
1. 打开浏览器 DevTools (F12)
2. 检查 Console 中的错误信息
3. 验证 localStorage 中存在 `auth_token`
   ```javascript
   console.log(localStorage.getItem('auth_token'))
   ```
4. 检查 Token 是否有效
   ```javascript
   console.log(localStorage.getItem('current_user'))
   ```

### 症状: Cypress 测试超时

**解决方案**:
1. 确保后端正在运行
2. 等待 5 秒钟让测试用户创建完成
3. 检查是否有防火墙阻止本地连接

## 🔐 生产环境配置

**重要**: 生产部署前必须执行以下操作：

```javascript
// 1. 删除所有测试账号
DELETE FROM users WHERE email LIKE '%example.com%';

// 2. 更新所有默认账号的密码
UPDATE users SET password_hash = 'SECURE_HASH_HERE' 
WHERE username IN ('admin', 'manager', 'user');

// 3. 禁用 NODE_ENV=development
// 在 backend/.env 中设置
NODE_ENV=production
```

## 📚 相关文档

- [LOGIN_TEST_GUIDE.md](./LOGIN_TEST_GUIDE.md) - 详细的登录测试指南
- [QUICK_START_TESTING.md](./QUICK_START_TESTING.md) - 快速测试指南
- [USER_MANAGER.md](../backend/modules/UserManager.js) - 用户管理模块文档

## 🔗 快速链接

| 功能 | URL |
|------|-----|
| 登录页面 | http://localhost:3000/login.html |
| 主应用 | http://localhost:3000/index.html |
| 健康检查 | http://localhost:3000/health |
| API 登录 | POST http://localhost:3000/api/user/login |

## 📊 验证步骤

### 1. 验证后端是否正常运行
```bash
curl http://localhost:3000/health
# 预期: {"status":"✅ API Server is running","timestamp":"2026-04-21T..."}
```

### 2. 验证测试用户是否创建
```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"TestPass123!"}'
# 预期: {"success":true,"token":"...","user":{...}}
```

### 3. 验证数据库中的用户
在 Supabase 中运行：
```sql
SELECT username, email, role, status 
FROM users 
WHERE email LIKE '%example.com%';
```

## 💡 开发提示

- 所有错误日志会输出到后端控制台
- 使用浏览器 DevTools 的 Network 标签查看 API 调用
- 在 `localStorage` 中查看保存的 Token 和用户信息
- 设置 `NODE_ENV=development` 启用调试信息

## 🆘 获取帮助

如果问题仍未解决：
1. 检查 `backend` 启动日志
2. 查看浏览器 Console 错误
3. 验证 `.env` 配置是否正确
4. 检查数据库连接状态
5. 查看 `docs/LOGIN_TEST_GUIDE.md` 的常见问题部分

---

**最后更新**: 2026-04-21 | **版本**: 1.0
