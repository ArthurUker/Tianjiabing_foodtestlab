# 🎯 快速参考卡片 - Admin 账号

## 📌 账号凭据

```
┌─────────────────────────────────┐
│  👤 Admin 账号                   │
├─────────────────────────────────┤
│  用户名:  admin                  │
│  密码:    8888                   │
│  邮箱:    admin@foodlab.com      │
│  角色:    管理员                 │
│  权限:    所有权限               │
└─────────────────────────────────┘
```

---

## ⚡ 快速操作

### 1️⃣ 启动后端
```bash
cd backend
npm start
```

### 2️⃣ 访问登录
```
http://localhost:3000/login.html
```

### 3️⃣ 输入凭据
```
用户名: admin
密码: 8888
```

### 4️⃣ 点击登录 ✅

---

## 🔍 验证方式

### 浏览器验证
1. 输入 admin / 8888
2. 点击登录
3. 成功进入主应用

### 命令行验证
```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}'
```

### 数据库验证
```sql
SELECT * FROM users WHERE username = 'admin';
```

---

## 🧪 其他测试账号

| 用户名 | 密码 | 用途 |
|--------|------|------|
| testuser | TestPass123! | E2E 测试 |
| qa_tester | TestPass123! | QA 测试 |

---

## 🔐 账号信息

| 项目 | 值 |
|------|-----|
| 用户名 | admin |
| 密码 | 8888 |
| 邮箱 | admin@foodlab.com |
| 全名 | 系统管理员 |
| 角色 | admin |
| 状态 | active |
| 密码哈希 | $2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m |

---

## 📖 相关文档

- 📚 [ADMIN_ACCOUNT_SETUP.md](./ADMIN_ACCOUNT_SETUP.md) - 详细设置指南
- 📚 [ACCOUNT_MANAGEMENT.md](./ACCOUNT_MANAGEMENT.md) - 账号管理指南
- 📚 [LOGIN_TEST_GUIDE.md](./LOGIN_TEST_GUIDE.md) - 登录测试指南

---

## 🆘 快速排查

| 问题 | 解决方案 |
|------|---------|
| 登录失败 | 检查后端是否运行 `npm start` |
| 密码错误 | 使用 `admin` 和 `8888` |
| 账号不存在 | 重启后端自动创建 |
| 忘记密码 | 运行 `bash scripts/admin-setup.sh` |

---

**打印此卡片以备快速参考！**
