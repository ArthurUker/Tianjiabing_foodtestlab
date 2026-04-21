#!/bin/bash

# 🔍 診断 Admin 账号问题

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  🔍 诊断 Admin 账号问题                 ║"
echo "╚════════════════════════════════════════╝"
echo ""

# 检查后端是否运行
echo "1️⃣  检查后端是否运行..."
if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "✅ 后端运行正常"
else
    echo "❌ 后端未运行！请先启动:"
    echo "   cd backend && npm start"
    exit 1
fi

echo ""
echo "2️⃣  检查 admin 账号是否存在..."

# 测试 admin 登录
response=$(curl -s -X POST http://localhost:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"8888"}')

echo "API 响应:"
echo "$response" | jq '.' 2>/dev/null || echo "$response"

echo ""

# 检查响应是否成功
if echo "$response" | grep -q '"success":true'; then
    echo "✅ Admin 账号存在且密码正确！"
    exit 0
elif echo "$response" | grep -q '用户不存在'; then
    echo "❌ Admin 账号不存在"
    echo ""
    echo "解决方案:"
    echo "1. 检查后端初始化日志 (查找 '✅ 用户创建成功')"
    echo "2. 重启后端服务:"
    echo "   cd backend && npm start"
    echo "3. 如果仍不存在，手动创建 SQL:"
    echo ""
    cat << 'EOF'
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('admin', 'admin@foodlab.com', '$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m', '系统管理员', 'admin', 'active')
ON CONFLICT (username) DO UPDATE SET 
    password_hash = EXCLUDED.password_hash;
EOF
    echo ""
    exit 1
elif echo "$response" | grep -q '密码错误'; then
    echo "❌ Admin 账号存在但密码错误"
    echo ""
    echo "解决方案:"
    echo "1. 检查密码是否为 8888"
    echo "2. 重置密码哈希:"
    echo "   cd backend"
    echo "   bash ../scripts/admin-setup.sh"
    exit 1
else
    echo "❌ 未知错误"
    echo "$response"
    exit 1
fi
