# ⚡ 快速修复 - 401 错误 (Admin 账号问题)

## 🎯 问题

```
POST http://localhost:3000/api/user/login 401 (Unauthorized)
❌ 登录失败: 用户不存在或密码错误
```

## ✅ 已修复的问题

1. ✅ **process 引用错误** - 修复了 login.html 中的 `process.env.NODE_ENV` 问题
2. 🔧 **Admin 账号创建** - 需要手动验证或重新初始化

---

## 🚀 立即修复 (3 步)

### 步骤 1: 重新初始化后端

```bash
# 停止后端 (如果正在运行，按 Ctrl+C)
# 然后重新启动：
cd backend
npm start
```

**查看日志，确保看到:**
```
✅ 用户创建成功: admin (admin@foodlab.com)
```

### 步骤 2: 清空浏览器缓存

```
快捷键: Ctrl+Shift+Delete
选择: 清除所有
```

### 步骤 3: 重新登录

```
URL: http://localhost:3000/login.html
用户名: admin
密码: 8888
```

---

## 📊 验证修复

### 方式 1: 浏览器登录 (最快)

1. 打开 http://localhost:3000/login.html
2. 输入 admin / 8888
3. 点击登录

**✅ 成功:** 跳转到主应用，Console 显示成功日志
**❌ 失败:** Console 显示 401 错误

### 方式 2: 命令行测试

```bash
# macOS/Linux:
bash scripts/diagnose-admin.sh

# Windows:
scripts/diagnose-admin.bat
```

### 方式 3: 直接 API 测试

```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}'
```

---

## 🔧 如果仍然失败

### 检查 1: 后端日志

重启后端，查看完整的启动日志。查找：

- ❌ 数据库连接错误
- ❌ Supabase 错误  
- ❌ 初始化错误

### 检查 2: 手动创建账号

在 Supabase SQL Editor 中运行：

```sql
DELETE FROM users WHERE username = 'admin';

INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('admin', 'admin@foodlab.com', '$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m', '系统管理员', 'admin', 'active');

SELECT * FROM users WHERE username = 'admin';
```

### 检查 3: 使用测试账号

试试其他测试账号是否可用：

```
用户名: testuser
密码: TestPass123!
```

如果测试账号也失败，说明是数据库连接问题。

---

## 🆘 最后手段

```bash
# 1. 完全重启后端
cd backend
npm start

# 2. 等待 3-5 秒让初始化完成

# 3. 刷新浏览器 (Ctrl+R)

# 4. 重新登录
```

---

## 📋 修复的代码

### login.html - 修复 process 引用

**之前:**
```javascript
if (process.env.NODE_ENV !== 'production') { ... }
```

**之后:**
```javascript
const isDevelopment = localStorage.getItem('debug_mode') === 'true' || 
                      window.location.hostname === 'localhost' || 
                      window.location.hostname === '127.0.0.1';

if (isDevelopment) { ... }
```

---

## ✨ 新增工具

- `scripts/diagnose-admin.sh` - Linux/Mac 诊断脚本
- `scripts/diagnose-admin.bat` - Windows 诊断脚本
- `docs/FIX_401_UNAUTHORIZED.md` - 完整诊断指南

---

## 🎉 预期结果

修复后：
- ✅ Console 不再显示 `ReferenceError: process is not defined`
- ✅ API 请求到正确的地址
- ✅ Admin 账号成功登录
- ✅ 显示调试信息（如果启用了 debug mode）

---

**需要帮助？** 查看 [FIX_401_UNAUTHORIZED.md](./FIX_401_UNAUTHORIZED.md)
