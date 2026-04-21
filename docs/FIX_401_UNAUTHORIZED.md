# 🔐 401 错误诊断与修复 - Admin 账号问题

## 🔴 问题

```
POST http://localhost:3000/api/user/login 401 (Unauthorized)
❌ 登录失败: 用户不存在或密码错误
```

## 🎯 根本原因

Admin 账号在数据库中不存在或密码不匹配。

---

## 🚀 快速诊断 (3 步)

### 步骤 1: 检查后端是否启动

```bash
cd backend
npm start
```

**查看日志，找这行:**
```
✅ 用户创建成功: admin (admin@foodlab.com)
```

**如果没有看到:**
- ❌ 说明初始化失败
- 查看完整启动日志获取错误信息

### 步骤 2: 测试 API（如果后端已启动）

```bash
# 运行诊断脚本
bash scripts/diagnose-admin.sh
```

**或手动测试:**
```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}'
```

**成功响应 (200):**
```json
{"success": true, "token": "...", "user": {...}}
```

**失败响应 (401):**
```json
{"error": "❌ 登录失败: 用户不存在或密码错误"}
```

### 步骤 3: 选择修复方案

---

## 🔧 修复方案

### 方案 A: 自动重新初始化 (推荐)

**最简单的方法:**

```bash
# 1. 停止后端 (按 Ctrl+C)
# 2. 清空数据库中的用户表
# 3. 重新启动后端
cd backend
npm start
```

**预期:**
后端会自动检测用户不存在并重新创建。

### 方案 B: 手动创建 Admin 账号

**步骤:**

1. 打开 Supabase SQL Editor
2. 复制以下 SQL:

```sql
-- 删除现有的 admin 账号 (如果存在)
DELETE FROM users WHERE username = 'admin';

-- 创建新的 admin 账号
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES (
    'admin', 
    'admin@foodlab.com', 
    '$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m',
    '系统管理员', 
    'admin', 
    'active'
);

-- 验证创建成功
SELECT * FROM users WHERE username = 'admin';
```

3. 执行 SQL
4. 刷新浏览器重新登录

### 方案 C: 使用管理脚本

```bash
cd backend
bash ../scripts/admin-setup.sh
# 选择选项 2 (创建/重置 admin 账号)
```

---

## 🔍 深度诊断

### 如果诊断脚本也失败

**检查列表:**

1. **Supabase 连接**
   ```bash
   # 检查 backend/.env
   cat backend/.env | grep SUPABASE
   # 应该看到 SUPABASE_URL 和 SUPABASE_KEY
   ```

2. **数据库中是否有用户表**
   ```sql
   -- 在 Supabase SQL Editor 中运行
   SELECT table_name FROM information_schema.tables 
   WHERE table_schema = 'public';
   ```
   
   应该看到 `users` 表。

3. **查看后端初始化日志**
   ```bash
   # 重启后端并仔细查看日志
   cd backend
   NODE_ENV=development npm start
   # 查找错误信息
   ```

### 如果 users 表不存在

**需要初始化数据库:**

```bash
# 1. 在 Supabase SQL Editor 中运行
# 复制 backend/sql/01_users_schema.sql 的内容并执行

# 2. 然后运行测试数据初始化
# 复制 backend/sql/02_seed_test_users.sql 的内容并执行

# 3. 重启后端
cd backend
npm start
```

---

## 📊 验证成功

完成以下任何一个步骤后，验证修复是否成功：

### 1. 浏览器登录
```
URL: http://localhost:3000/login.html
用户名: admin
密码: 8888
```

预期: ✅ 成功登录，重定向到主应用

### 2. API 测试
```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}'
```

预期: ✅ 返回 `"success": true`

### 3. 数据库查询
```sql
SELECT username, email, role, status FROM users WHERE username = 'admin';
```

预期: ✅ 返回一行数据

---

## 🎯 完整检查清单

按顺序检查：

- [ ] 后端已启动 (`npm start` in backend)
- [ ] 看到初始化日志 ("✅ 用户创建成功")
- [ ] Supabase 连接正常 (检查 .env 文件)
- [ ] Users 表存在 (SQL 查询确认)
- [ ] Admin 账号在数据库中 (SQL 查询确认)
- [ ] 密码哈希正确 (应该是 $2a$10$mgqlRFCdDMgNIkLi/...)
- [ ] 账号状态为 'active'
- [ ] 浏览器缓存已清空 (Ctrl+Shift+Delete)
- [ ] 使用了正确的凭据 (admin / 8888)

---

## 🆘 仍然无法解决？

### 收集诊断信息

```bash
# 1. 保存后端启动日志
cd backend
npm start 2>&1 | tee startup.log

# 2. 导出当前用户列表 SQL 查询结果
# 在 Supabase 中运行: SELECT * FROM users; 

# 3. 运行诊断脚本
bash scripts/diagnose-admin.sh > diagnosis.log

# 将这些文件提交给开发团队
```

### 重置环境 (最后手段)

```bash
# 1. 停止后端
# 2. 删除本地数据库缓存
rm -rf backend/node_modules/.supabase

# 3. 清空 Supabase 数据库
# 在 Supabase dashboard 中：Settings → Delete Project

# 4. 重新创建数据库
# 运行 backend/sql/01_users_schema.sql

# 5. 重启后端
cd backend
npm start
```

---

## 📞 相关文档

- [ADMIN_ACCOUNT_SETUP.md](./ADMIN_ACCOUNT_SETUP.md) - Admin 账号设置
- [ACCOUNT_MANAGEMENT.md](./ACCOUNT_MANAGEMENT.md) - 账号管理
- [LOGIN_TROUBLESHOOTING.md](./LOGIN_TROUBLESHOOTING.md) - 登录问题排查

---

**最后更新**: 2026-04-21 | **版本**: 1.0
