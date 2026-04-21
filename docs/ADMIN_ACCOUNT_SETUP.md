# ✅ Admin 账号设置完成

## 📋 账号信息

已为你创建了一个 **admin** 测试账号，具体信息如下：

| 字段 | 值 |
|------|-----|
| **用户名** | `admin` |
| **密码** | `8888` |
| **邮箱** | `admin@foodlab.com` |
| **角色** | 管理员 |
| **权限** | 所有权限 |

---

## 🚀 立即使用

### 第 1 步: 启动后端服务
```bash
cd backend
npm start
```

**预期输出:**
```
✅ API Server is running on port 3000
🔧 开始初始化测试用户...
✅ 用户创建成功: admin (admin@foodlab.com)
✅ 用户初始化完成，新建 X 个，更新 X 个
```

### 第 2 步: 访问登录页面
```
http://localhost:3000/login.html
或
file:///path/to/login.html
```

### 第 3 步: 使用账号登录

**输入以下凭据:**
```
用户名: admin
密码: 8888
```

**或者使用邮箱登录:**
```
用户名: admin@foodlab.com
密码: 8888
```

---

## 🔍 验证账号

### 方式 1: 浏览器登录 (推荐)
1. 打开登录页面
2. 输入 `admin` / `8888`
3. 点击登录
4. 成功进入主应用

### 方式 2: API 测试
```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}'
```

**预期响应:**
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

### 方式 3: 数据库查询
在 Supabase SQL Editor 中运行：
```sql
SELECT username, email, role, status FROM users WHERE username = 'admin';
```

---

## 📊 账号初始化方式

### 自动初始化 ✅ (推荐)
当你启动后端服务时，系统会自动：
1. 检查 admin 账号是否存在
2. 如果不存在，创建新的 admin 账号
3. 如果存在但密码不匹配，更新密码为 8888
4. 输出操作日志

### 手动初始化 (可选)
如果自动初始化失败，可以在 Supabase SQL Editor 中手动运行：

```sql
-- 创建或更新 admin 账号
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('admin', 'admin@foodlab.com', '$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m', '系统管理员', 'admin', 'active')
ON CONFLICT (username) DO UPDATE SET 
    password_hash = EXCLUDED.password_hash,
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name;
```

---

## 🔐 账号信息详解

### 密码: 8888

- **纯文本**: `8888`
- **加密方式**: bcryptjs (10 轮盐)
- **哈希值**: `$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m`

### 账号权限

作为管理员，该账号拥有以下权限：
- ✅ 查看所有数据
- ✅ 管理用户账号
- ✅ 访问审计日志
- ✅ 管理系统设置
- ✅ 查看报告
- ✅ 导出数据

---

## 📚 其他可用账号

系统还提供了以下测试账号供开发和 E2E 测试使用：

| 用户名 | 密码 | 用途 |
|--------|------|------|
| testuser | TestPass123! | E2E 自动化测试 |
| qa_tester | TestPass123! | QA 手动测试 |

---

## 🛠️ 管理员操作

登录后，你可以在管理面板进行以下操作：

### 用户管理
- 👥 创建新用户
- 🔧 编辑用户信息
- 🚫 禁用/启用用户
- 🗑️ 删除用户

### 审计日志
- 📋 查看所有操作日志
- 🔍 按日期/用户过滤
- 📊 生成审计报告

### 系统设置
- ⚙️ 配置系统参数
- 🔐 管理权限
- 📊 查看系统统计

---

## 🆘 常见问题

### Q: 忘记密码怎么办？

**A**: 
1. 在 Supabase SQL Editor 中更新密码哈希值
2. 使用脚本快速生成新密码哈希：
   ```bash
   cd backend
   bash ../scripts/admin-setup.sh
   # 或 Windows: admin-setup.bat
   ```

### Q: 需要更改 admin 密码吗？

**A**: 建议在以下场景更改：
- ✅ 部署到生产环境前
- ✅ 定期安全审计时
- ✅ 员工离职时

### Q: 如何创建其他管理员账号？

**A**: 
1. 用 admin 账号登录
2. 进入"用户管理"面板
3. 创建新用户并设置角色为"admin"

### Q: Admin 账号安全吗？

**A**: 
- ✅ 密码使用 bcryptjs 加密存储
- ✅ API 需要 JWT Token 验证
- ✅ 建议定期更改密码
- ✅ 建议启用 2FA (可选)

---

## 📖 相关文档

- [ACCOUNT_MANAGEMENT.md](./ACCOUNT_MANAGEMENT.md) - 详细账号管理指南
- [LOGIN_TEST_GUIDE.md](./LOGIN_TEST_GUIDE.md) - 登录测试指南
- [LOGIN_TROUBLESHOOTING.md](./LOGIN_TROUBLESHOOTING.md) - 问题排查指南

---

## 🔗 快速链接

| 功能 | URL/命令 |
|------|---------|
| 登录页面 | http://localhost:3000/login.html |
| 主应用 | http://localhost:3000/index.html |
| API 文档 | http://localhost:3000/api/docs |
| Admin 设置脚本 | `bash scripts/admin-setup.sh` |

---

## ✨ 下一步建议

1. ✅ **验证登录** - 用 admin/8888 登录验证账号
2. ✅ **浏览功能** - 探索管理员面板的各项功能
3. ✅ **运行测试** - 执行 `npm run cypress:run` 运行自动化测试
4. ✅ **阅读文档** - 查看 [ACCOUNT_MANAGEMENT.md](./ACCOUNT_MANAGEMENT.md) 了解更多

---

**最后更新**: 2026-04-21 | **版本**: 1.0
