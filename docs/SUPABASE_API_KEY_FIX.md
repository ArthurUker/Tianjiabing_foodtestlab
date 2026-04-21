# 🔑 Supabase API Key 配置指南

## 🔴 当前问题

```
❌ 创建测试用户 admin 失败: Invalid API key
```

这意味着 `backend/.env` 中的 `SUPABASE_KEY` 无效。

---

## ✅ 如何获取正确的 API Key

### 方式 1: 从 Supabase 控制面板获取 (推荐)

#### 步骤 1: 登录 Supabase

访问 https://app.supabase.com 并登录您的账户

#### 步骤 2: 选择项目

找到您的 `Tianjiabing_foodtestlab` 项目

#### 步骤 3: 获取 API 密钥

```
点击: Settings (设置) → API
```

看到两个密钥:
- **anon/public key** - 前端使用 (当前需要)
- **service_role key** - 后端使用

#### 步骤 4: 复制 anon/public key

```
╔════════════════════════════════════════╗
║  API Keys                              ║
├────────────────────────────────────────┤
║ PROJECT URL                            ║
║ https://[project-id].supabase.co       ║
├────────────────────────────────────────┤
║ ANON/PUBLIC KEY  <- 复制这个            ║
║ eyJhbGciOi...                          ║
├────────────────────────────────────────┤
║ SERVICE_ROLE KEY (不需要)               ║
║ eyJhbGciOi...                          ║
╚════════════════════════════════════════╝
```

---

## 🔧 更新配置

### 步骤 1: 编辑 .env 文件

```bash
cd backend
nano .env  # 或使用您喜欢的编辑器
```

### 步骤 2: 更新 SUPABASE_KEY

```ini
# 旧值 (无效)
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# 新值 (从 Supabase 复制)
SUPABASE_KEY=eyJhbGciOi... [您的正确密钥]
```

### 步骤 3: 保存文件

```bash
# Ctrl+S (在编辑器中)
# 或 Ctrl+O, Enter, Ctrl+X (nano)
```

---

## 🚀 测试配置

### 运行诊断脚本

```bash
cd backend
node ../scripts/test-supabase-connection.js
```

### 预期输出

```
✅ 所有诊断测试通过！
```

### 如果失败

如果仍然显示 `Invalid API key`，说明:

1. **Supabase 项目被删除** - 需要重新创建或使用新项目
2. **Supabase 项目不存在** - 检查 SUPABASE_URL 是否正确
3. **复制错误** - 确保完整复制了整个密钥 (没有多余空格)
4. **密钥类型错误** - 确保是 `anon/public key` 而不是 `service_role key`

---

## 📝 完整的 .env 模板

```ini
# Supabase Configuration
SUPABASE_URL=https://[project-id].supabase.co
SUPABASE_KEY=[您的-anon-public-key]

# API Configuration
PORT=3000
NODE_ENV=development

# JWT Configuration
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRE=7d

# CORS Configuration
CORS_ORIGIN=*
```

---

## 🐛 常见问题

### Q: 为什么显示 "Invalid API key"?

**A:** 可能原因:
- ❌ 密钥已过期
- ❌ 密钥不完整 (复制时遗漏了部分)
- ❌ Supabase 项目被删除
- ❌ 使用了 service_role key 而不是 anon key
- ❌ 网络连接问题

### Q: 我从哪里找到项目 ID?

**A:** 项目 ID 在 Supabase URL 中:
```
https://[project-id].supabase.co
             ↑
          这就是项目 ID
```

### Q: 需要使用 service_role key 吗?

**A:** 现在不需要。后端使用 `anon/public key` 足够了。

### Q: 如何重新生成密钥?

**A:** 在 Supabase Settings → API → Regenerate 中重新生成 (注意: 旧密钥会失效)

---

## 🎯 完整修复流程

1. ✅ 访问 Supabase 控制面板
2. ✅ 复制正确的 anon/public key
3. ✅ 更新 `backend/.env` 中的 `SUPABASE_KEY`
4. ✅ 运行诊断脚本验证: `node scripts/test-supabase-connection.js`
5. ✅ 重启后端: `npm run dev`
6. ✅ 检查是否看到 `✅ 用户创建成功: admin`
7. ✅ 尝试登录: admin / 8888

---

## 🆘 仍然失败?

如果诊断脚本显示其他错误:

```bash
# 查看完整错误日志
node ../scripts/test-supabase-connection.js 2>&1 | tail -20
```

**常见错误:**
- `Failed to fetch` → 网络问题或 SUPABASE_URL 错误
- `users table does not exist` → 需要运行数据库初始化
- `permission denied` → 密钥权限不足

---

## ✨ 修复后

一旦 Supabase 连接成功:

1. ✅ 后端启动时会自动创建 admin 账号
2. ✅ 您可以使用 `admin` / `8888` 登录
3. ✅ Cypress 测试应该开始工作
4. ✅ 所有 E2E 测试应该通过
