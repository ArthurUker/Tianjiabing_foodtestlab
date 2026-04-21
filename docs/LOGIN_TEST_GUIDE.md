## 🔐 登录测试指南

### 测试账号信息

系统提供了以下测试账号供开发和测试使用：

#### 默认系统账号 (默认已创建)
| 用户名 | 邮箱 | 密码 | 角色 | 状态 |
|--------|------|------|------|------|
| admin | admin@foodlab.com | 密码同下 | 管理员 | 活跃 |
| manager | manager@foodlab.com | 密码同下 | 经理 | 活跃 |
| user | user@foodlab.com | 密码同下 | 普通用户 | 活跃 |

**⚠️ 注意**: 默认账号的密码哈希值需要在生产部署前更新

#### 自动创建的测试账号 (开发/测试环境)
| 用户名 | 邮箱 | 密码 | 角色 | 用途 |
|--------|------|------|------|------|
| testuser | testuser@example.com | TestPass123! | 普通用户 | Cypress E2E 基础测试 |
| qa_tester | qa@example.com | TestPass123! | 普通用户 | QA 测试 |
| disabled_user | disabled@example.com | TestPass123! | 普通用户 | 测试禁用账号 |

---

## 🚀 快速开始

### 1. 后端启动 (自动初始化测试用户)

```bash
cd backend
npm install
npm start
```

**输出示例**:
```
✅ API Server is running on port 3000
🔧 开始初始化测试用户...
✅ 测试用户创建成功: testuser (testuser@example.com)
✅ 测试用户创建成功: qa_tester (qa@example.com)
✅ 测试用户创建成功: disabled_user (disabled@example.com)
✅ 测试用户初始化完成，新建 3 个用户
```

### 2. 登录页面测试

访问 `http://localhost:3000/login.html` 并使用以下凭据登录：

```
用户名: testuser
密码: TestPass123!
```

### 3. 运行 Cypress E2E 测试

```bash
npm run cypress:open
# 或
npm run cypress:run
```

---

## 🐛 常见问题排查

### 问题 1: "用户不存在或密码错误"

**原因**: 登录时输入的用户名或密码错误

**解决方案**:
1. 检查用户名是否存在
   ```bash
   curl http://localhost:3000/api/user/login \
     -X POST \
     -H "Content-Type: application/json" \
     -d '{"username":"testuser","password":"TestPass123!"}'
   ```

2. 验证测试用户是否已创建
   - 启动后端服务会自动创建测试用户
   - 检查后端日志是否显示 "✅ 测试用户创建成功"

3. 确保数据库连接正确
   - 检查 `.env` 文件中的 `SUPABASE_URL` 和 `SUPABASE_KEY`

### 问题 2: 登录后立即被重定向回登录页

**原因**: Token 生成或保存失败

**解决方案**:
1. 打开浏览器开发者工具 (F12)
2. 查看 Console 标签中的错误信息
3. 检查 localStorage 中是否有 `auth_token`
   ```javascript
   console.log(localStorage.getItem('auth_token'))
   ```

### 问题 3: Cypress 测试失败 - "登录失败"

**原因**: 测试用户未创建或后端未运行

**解决方案**:
1. 确保后端已启动
   ```bash
   cd backend
   npm start
   ```

2. 确保数据库中存在 testuser
   ```sql
   SELECT * FROM users WHERE username = 'testuser';
   ```

3. 手动创建测试用户
   ```bash
   # 使用 Supabase SQL Editor 运行
   psql -U postgres -d your_database -f backend/sql/02_seed_test_users.sql
   ```

---

## 🔑 更新默认账号密码 (生产环境)

生产部署前，必须更新所有默认账号的密码：

```javascript
const bcryptjs = require('bcryptjs');

// 生成新的密码哈希
async function generatePasswordHash(password) {
    return await bcryptjs.hash(password, 10);
}

// 使用示例
const newPassword = 'YourSecurePassword123!';
generatePasswordHash(newPassword).then(hash => {
    console.log('使用此哈希值更新数据库:');
    console.log(hash);
});
```

然后在 Supabase 中更新用户密码：

```sql
UPDATE users 
SET password_hash = 'NEW_HASH_VALUE'
WHERE username = 'admin';
```

---

## 🧪 自动化测试说明

### Cypress 测试配置

测试使用的用户名和密码在 `cypress/e2e/auth.cy.js` 中定义：

```javascript
cy.get('input[type="email"]').first().type('testuser@example.com');
cy.get('input[type="password"]').first().type('TestPass123!');
```

### 运行特定测试

```bash
# 只运行登录测试
npm run cypress:run -- --spec "cypress/e2e/auth.cy.js"

# 交互模式
npm run cypress:open
```

---

## 📊 监控和验证

### 检查登录日志

```sql
SELECT * FROM login_logs 
WHERE user_id = (SELECT id FROM users WHERE username = 'testuser')
ORDER BY created_at DESC;
```

### 查看用户统计

```sql
SELECT * FROM get_user_statistics();
```

---

## 🔐 安全建议

1. **生产环境**:
   - ✅ 删除所有测试账号
   - ✅ 更新所有默认密码
   - ✅ 启用 HTTPS
   - ✅ 配置防火墙规则

2. **开发环境**:
   - ✅ 在本地运行测试
   - ✅ 定期检查登录日志
   - ✅ 监控失败的登录尝试

3. **密码安全**:
   - 长度至少 8 个字符
   - 包含大小写字母、数字和特殊符号
   - 定期更换密码
   - 不要在代码中硬编码密码

---

## 📞 获取帮助

如果遇到问题，请检查：
1. 后端错误日志
2. 浏览器 Console 错误
3. Cypress 测试报告
4. 数据库连接状态
