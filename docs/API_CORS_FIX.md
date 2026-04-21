# 🔧 API 请求错误 (405 Method Not Allowed) - 解决方案

## 🔴 问题描述

浏览器控制台显示以下错误：
```
POST http://127.0.0.1:5500/api/user/login 405 (Method Not Allowed)
❌ 登录错误: Failed to execute 'json' on 'Response': Unexpected end of JSON input
```

## 🎯 根本原因

| 问题 | 说明 |
|------|------|
| **前端地址** | `http://127.0.0.1:5500/` (Live Server) |
| **后端地址** | `http://localhost:3000/` (Express API) |
| **API 调用** | 尝试请求 `http://127.0.0.1:5500/api/user/login` |
| **结果** | ❌ 5500 端口没有 API，返回 405 |

## ✅ 解决方案（已实施）

### 修复内容

在 `js/services/AuthService.js` 中添加了 **自动 API 地址检测**：

```javascript
// 自动检测 API 基础 URL
function getApiBaseUrl() {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    
    // 本地开发环境 → 使用 localhost:3000
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return `${protocol}//localhost:3000`;
    }
    
    // 生产环境 → 使用相同的域名
    return `${protocol}//${window.location.host}`;
}

export const authService = new AuthService(getApiBaseUrl());
```

### 工作原理

| 场景 | 前端 URL | API URL |
|------|---------|---------|
| Live Server | `http://127.0.0.1:5500/` | `http://localhost:3000/api/...` ✅ |
| 本地开发 | `http://localhost:3000/` | `http://localhost:3000/api/...` ✅ |
| 生产环境 | `https://example.com/` | `https://example.com/api/...` ✅ |

---

## 🚀 验证修复

### 1. 确保后端运行

```bash
cd backend
npm start
```

**预期输出:**
```
✅ API Server is running on port 3000
✅ 用户创建成功: admin (admin@foodlab.com)
```

### 2. 访问登录页面

**方式 A: 直接访问 (推荐)**
```
http://localhost:3000/login.html
```

**方式 B: 使用 Live Server**
```
http://127.0.0.1:5500/login.html
```
- 会自动重定向到 `http://localhost:3000/api/...`

### 3. 打开浏览器控制台 (F12)

**验证成功:**
```
✅ POST http://localhost:3000/api/user/login 200 OK
✅ 登录成功，Token 已保存
✅ 跳转到主应用...
```

**如果仍然失败:**
```
❌ POST http://127.0.0.1:5500/api/user/login 405
→ 刷新页面或清空缓存
```

### 4. 使用测试账号登录

```
用户名: admin
密码: 8888
```

---

## 📊 问题排查清单

| 检查项 | 症状 | 解决方案 |
|--------|------|---------|
| 后端未运行 | 无法连接到 3000 | `cd backend && npm start` |
| 使用了错误的端口 | 仍然访问 5500 | 改为 `http://localhost:3000` |
| 缓存问题 | 修复后仍然出错 | 清空浏览器缓存或使用无痕模式 |
| CORS 问题 | 跨域请求被阻止 | 检查后端 CORS 配置 |
| API 地址错误 | 查看 F12 Network | 确认请求 URL 是否正确 |

---

## 🔍 调试技巧

### 1. 查看 Network 标签

1. 打开浏览器 DevTools (F12)
2. 切换到 **Network** 标签
3. 尝试登录
4. 查看 POST 请求
5. **验证 URL** 应该是 `http://localhost:3000/api/user/login`

### 2. 查看 Console 输出

```javascript
// 在 Console 中运行，查看自动检测的 API 地址
import { authService } from './js/services/AuthService.js';
console.log('API Base URL:', authService.apiBaseUrl);
```

**输出示例:**
```
API Base URL: http://localhost:3000
```

### 3. 手动测试 API

```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}'
```

**成功响应:**
```json
{
  "success": true,
  "token": "eyJhbGc...",
  "user": {...}
}
```

---

## 📋 后端 CORS 配置

如果还有 CORS 问题，检查 `backend/server.js`：

```javascript
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
```

如果需要调整，编辑 `backend/.env`：
```env
CORS_ORIGIN=http://localhost:5500,http://localhost:3000
```

---

## 🎯 完整登录流程

```
1. 用户访问 login.html (5500 或 3000)
   ↓
2. AuthService 自动检测 API 地址
   ↓
3. 用户输入凭据 (admin / 8888)
   ↓
4. 发送 POST 请求到 http://localhost:3000/api/user/login ✅
   ↓
5. 后端验证凭据
   ↓
6. 返回 Token 和用户信息
   ↓
7. 保存到 localStorage
   ↓
8. 重定向到 index.html ✅
```

---

## 📚 相关文档

- [ADMIN_ACCOUNT_SETUP.md](./ADMIN_ACCOUNT_SETUP.md) - 账号设置指南
- [LOGIN_TEST_GUIDE.md](./LOGIN_TEST_GUIDE.md) - 登录测试指南
- [QUICK_REFERENCE_ADMIN.md](./QUICK_REFERENCE_ADMIN.md) - 快速参考

---

## 🆘 仍然有问题？

### 检查清单

- [ ] 后端已启动 (`npm start` in backend)
- [ ] 使用了正确的地址 (`http://localhost:3000`)
- [ ] 没有缓存问题 (清空浏览器缓存)
- [ ] 使用了正确的凭据 (admin / 8888)
- [ ] 没有防火墙阻止 (检查端口 3000)
- [ ] 使用了正确的浏览器 (新版 Chrome/Firefox)

### 获取更多帮助

1. 查看浏览器 Console 错误信息
2. 检查后端启动日志
3. 运行 `curl` 测试 API
4. 清空 localStorage 并重试

---

**最后更新**: 2026-04-21 | **版本**: 1.0
