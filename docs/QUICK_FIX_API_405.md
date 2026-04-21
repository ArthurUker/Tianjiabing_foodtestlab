# ⚡ 快速修复验证 - API 405 错误

## 🎯 问题
```
POST http://127.0.0.1:5500/api/user/login 405 (Method Not Allowed)
```

## ✅ 解决方案（已完成）

已修复 `js/services/AuthService.js`，添加了自动 API 地址检测。

---

## 🚀 验证步骤 (5 分钟)

### 步骤 1: 启动后端 (如果还未启动)

```bash
cd backend
npm start
```

**检查输出:**
```
✅ API Server is running on port 3000
✅ 用户创建成功: admin
```

### 步骤 2: 重新加载登录页面

**如果在 5500 端口:**
```
http://127.0.0.1:5500/login.html
```

**或直接使用 3000 端口:**
```
http://localhost:3000/login.html
```

### 步骤 3: 打开浏览器 DevTools (F12)

切换到 **Console** 标签，查看输出：

**✅ 成功的输出:**
```
🔧 Router 初始化中...
✅ Router 初始化完成
API Base URL: http://localhost:3000
```

**❌ 失败的输出:**
```
API Base URL: http://127.0.0.1:5500
```

### 步骤 4: 输入登录凭据

```
用户名: admin
密码: 8888
```

### 步骤 5: 验证成功

**Console 应该显示:**
```
✅ POST http://localhost:3000/api/user/login 200 OK
✅ 登录成功：admin
✅ 登录成功，跳转到主界面...
```

---

## 📊 快速诊断

### 如果看到这个错误
```
POST http://127.0.0.1:5500/api/user/login 405
```

**原因**: 仍然在 5500 端口访问

**解决:**
1. 清空浏览器缓存 (Ctrl+Shift+Delete)
2. 重新加载页面
3. 或直接访问 `http://localhost:3000/login.html`

### 如果看到这个错误
```
Unexpected end of JSON input
```

**原因**: API 没有正确响应

**解决:**
1. 确保后端在 3000 端口运行
2. 检查网络标签中的响应内容
3. 运行 `curl` 测试

---

## 🔧 手动 API 测试

在终端运行：

```bash
curl -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}'
```

**成功响应 (200):**
```json
{
  "success": true,
  "token": "eyJhbGc...",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@foodlab.com",
    "fullName": "系统管理员",
    "role": "admin"
  }
}
```

**失败响应 (405):**
```
Cannot POST /api/user/login
```
→ 表示后端未启动或 API 不存在

---

## ✨ 修改内容

### 文件: `js/services/AuthService.js`

**新增代码:**
```javascript
// 自动检测 API 基础 URL
function getApiBaseUrl() {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return `${protocol}//localhost:3000`;
    }
    
    return `${protocol}//${window.location.host}`;
}

export const authService = new AuthService(getApiBaseUrl());
```

---

## 📋 最终清单

- [ ] 后端正在 3000 端口运行
- [ ] 浏览器缓存已清空
- [ ] 页面已重新加载
- [ ] Console 显示正确的 API 地址
- [ ] 登录 admin/8888 成功
- [ ] 重定向到主应用

---

## 🎉 修复完成！

现在你应该能够成功登录。如果仍有问题，请查看 [API_CORS_FIX.md](./API_CORS_FIX.md)
