# 👤 系统账号管理指南

## 📝 系统内置账号

### 🔐 管理员账号 (Admin)

**用途**: 系统管理员账号，拥有所有权限

| 字段 | 值 |
|------|-----|
| **用户名** | `admin` |
| **密码** | `8888` |
| **邮箱** | `admin@foodlab.com` |
| **角色** | 管理员 (admin) |
| **状态** | 活跃 (active) |
| **权限** | 所有权限 |

**密码哈希**: `$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m`

---

## 🧪 测试账号

系统会自动在开发/测试环境创建以下测试账号：

### 1. 普通测试用户

| 字段 | 值 |
|------|-----|
| 用户名 | `testuser` |
| 邮箱 | `testuser@example.com` |
| 密码 | `TestPass123!` |
| 角色 | 普通用户 |
| 用途 | E2E 自动化测试 |

### 2. QA 测试员

| 字段 | 值 |
|------|-----|
| 用户名 | `qa_tester` |
| 邮箱 | `qa@example.com` |
| 密码 | `TestPass123!` |
| 角色 | 普通用户 |
| 用途 | QA 手动测试 |

### 3. 禁用用户 (测试用)

| 字段 | 值 |
|------|-----|
| 用户名 | `disabled_user` |
| 邮箱 | `disabled@example.com` |
| 密码 | `TestPass123!` |
| 角色 | 普通用户 |
| 状态 | 已禁用 |
| 用途 | 测试禁用账号登录 |

---

## 🚀 快速登录

### 登录 Admin 账号
```
用户名: admin
密码: 8888
```

### 登录测试账号
```
用户名: testuser
密码: TestPass123!
```

---

## 🔧 账号初始化方式

### 方式 1: 自动初始化 (推荐)

**启动后端服务后会自动创建账号:**
```bash
cd backend
npm start
```

**预期日志输出:**
```
✅ 用户创建成功: admin (admin@foodlab.com)
✅ 用户创建成功: testuser (testuser@example.com)
✅ 用户创建成功: qa_tester (qa@example.com)
✅ 用户创建成功: disabled_user (disabled@example.com)
✅ 用户初始化完成，新建 4 个，更新 0 个
```

### 方式 2: 手动初始化 (Supabase SQL)

在 Supabase SQL Editor 中运行 `backend/sql/01_users_schema.sql`

---

## 🔑 账号密码说明

### Admin (8888)

- **纯文本**: `8888`
- **加密方式**: bcryptjs (salt: 10)
- **用途**: 系统默认管理员账号
- **生成命令**:
  ```bash
  node -e "const bcryptjs = require('bcryptjs'); bcryptjs.hash('8888', 10, (err, hash) => { console.log(hash); });"
  ```

### 测试账号 (TestPass123!)

- **纯文本**: `TestPass123!`
- **加密方式**: bcryptjs (salt: 10)
- **用途**: 自动化测试和 QA 测试
- **生成命令**:
  ```bash
  node -e "const bcryptjs = require('bcryptjs'); bcryptjs.hash('TestPass123!', 10, (err, hash) => { console.log(hash); });"
  ```

---

## 🔐 生产环境注意事项

**⚠️ 重要**: 部署生产环境前必须执行以下操作：

### 1. 删除所有测试账号
```sql
DELETE FROM users WHERE email LIKE '%example.com%' OR username = 'testuser' OR username = 'qa_tester' OR username = 'disabled_user';
```

### 2. 更改 Admin 密码
```bash
# 生成新的安全密码哈希
node -e "const bcryptjs = require('bcryptjs'); bcryptjs.hash('YOUR_SECURE_PASSWORD', 10, (err, hash) => { console.log(hash); });"
```

然后在 Supabase 中执行：
```sql
UPDATE users SET password_hash = 'NEW_HASH_HERE' WHERE username = 'admin';
```

### 3. 设置生产环境变量
```env
NODE_ENV=production
CORS_ORIGIN=https://your-production-domain.com
```

---

## 📊 验证账号是否创建成功

### 方式 1: 数据库查询
在 Supabase SQL Editor 中运行：
```sql
SELECT username, email, role, status FROM users WHERE username IN ('admin', 'testuser', 'qa_tester', 'disabled_user');
```

### 方式 2: 登录测试
1. 访问登录页: `http://localhost:3000/login.html`
2. 使用 admin / 8888 登录
3. 应该成功进入主应用

### 方式 3: API 测试
```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}'
```

**预期响应**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@foodlab.com",
    "fullName": "系统管理员",
    "role": "admin"
  }
}
```

---

## 🆘 常见问题

### Q1: 登录时提示"用户不存在或密码错误"

**A**: 
- 检查后端是否启动 (应显示 "API Server is running on port 3000")
- 检查是否有初始化日志 (应显示 "✅ 用户创建成功")
- 尝试清空浏览器 localStorage 并重新刷新
- 检查数据库连接是否正常

### Q2: 忘记 Admin 密码怎么办？

**A**: 
1. 在 Supabase SQL Editor 中更新密码哈希值
2. 生成新密码的哈希值:
   ```bash
   node -e "const bcryptjs = require('bcryptjs'); bcryptjs.hash('NEWPASSWORD', 10, (err, hash) => { console.log(hash); });"
   ```
3. 更新数据库:
   ```sql
   UPDATE users SET password_hash = 'NEW_HASH' WHERE username = 'admin';
   ```

### Q3: 需要创建其他管理员账号吗？

**A**: 可以在 Supabase 中手动创建，或修改 `backend/config/testDataInitializer.js` 添加新的账号

---

## 📚 相关文档

- [LOGIN_TEST_GUIDE.md](./LOGIN_TEST_GUIDE.md) - 登录测试完整指南
- [LOGIN_TROUBLESHOOTING.md](./LOGIN_TROUBLESHOOTING.md) - 问题排查指南

---

**最后更新**: 2026-04-21 | **版本**: 1.0
