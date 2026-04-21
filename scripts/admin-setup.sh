#!/bin/bash

# 🔐 Admin Account Setup Script
# 快速创建或重置 admin 账号

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  🔐 Admin Account Setup Tool           ║"
echo "║  快速创建/重置管理员账号              ║"
echo "╚════════════════════════════════════════╝"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 检查 bcryptjs
if ! npm list bcryptjs > /dev/null 2>&1; then
    echo -e "${RED}❌ 错误: 未找到 bcryptjs${NC}"
    echo "请在 backend 目录中运行: npm install bcryptjs"
    exit 1
fi

echo -e "${BLUE}📝 Admin Account Setup${NC}"
echo ""
echo "1. 生成密码哈希"
echo "2. 创建/重置 admin 账号"
echo "3. 验证账号"
echo "4. 退出"
echo ""

read -p "请选择 (1-4): " choice

case $choice in
    1)
        echo ""
        echo -e "${BLUE}📝 生成密码哈希${NC}"
        read -p "请输入密码 (默认: 8888): " password
        password=${password:-8888}
        
        echo ""
        echo "正在生成哈希值..."
        hash=$(node -e "const bcryptjs = require('bcryptjs'); bcryptjs.hash('${password}', 10, (err, hash) => { if(err) console.error(err); else console.log(hash); });")
        
        echo ""
        echo -e "${GREEN}✅ 生成成功${NC}"
        echo ""
        echo "密码: ${password}"
        echo "哈希值:"
        echo -e "${BLUE}${hash}${NC}"
        echo ""
        echo "💡 提示: 复制上面的哈希值，在 Supabase 中更新 users 表"
        echo "SQL 命令:"
        echo -e "${YELLOW}UPDATE users SET password_hash = '${hash}' WHERE username = 'admin';${NC}"
        ;;
    
    2)
        echo ""
        echo -e "${BLUE}🔧 创建/重置 Admin 账号${NC}"
        echo ""
        read -p "请输入 admin 密码 (默认: 8888): " password
        password=${password:-8888}
        
        read -p "请输入 admin 邮箱 (默认: admin@foodlab.com): " email
        email=${email:-admin@foodlab.com}
        
        read -p "请输入 admin 全名 (默认: 系统管理员): " fullname
        fullname=${fullname:-系统管理员}
        
        echo ""
        echo "正在生成密码哈希..."
        hash=$(node -e "const bcryptjs = require('bcryptjs'); bcryptjs.hash('${password}', 10, (err, hash) => { if(err) console.error(err); else console.log(hash); });")
        
        if [ -z "$hash" ]; then
            echo -e "${RED}❌ 哈希生成失败${NC}"
            exit 1
        fi
        
        echo ""
        echo "账号信息:"
        echo "  用户名: admin"
        echo "  密码: ${password}"
        echo "  邮箱: ${email}"
        echo "  全名: ${fullname}"
        echo "  角色: admin"
        echo ""
        
        read -p "确认创建/更新? (y/n): " confirm
        if [ "$confirm" != "y" ]; then
            echo "已取消"
            exit 0
        fi
        
        echo ""
        echo "💡 请在 Supabase SQL Editor 中运行以下命令:"
        echo ""
        echo -e "${YELLOW}INSERT INTO users (username, email, password_hash, full_name, role, status)"
        echo "VALUES ('admin', '${email}', '${hash}', '${fullname}', 'admin', 'active')"
        echo "ON CONFLICT (username) DO UPDATE SET"
        echo "  password_hash = EXCLUDED.password_hash,"
        echo "  email = EXCLUDED.email,"
        echo "  full_name = EXCLUDED.full_name;${NC}"
        echo ""
        echo -e "${GREEN}✅ 或者重启后端服务会自动更新${NC}"
        ;;
    
    3)
        echo ""
        echo -e "${BLUE}🔍 验证 Admin 账号${NC}"
        echo ""
        
        read -p "请输入 admin 用户名 (默认: admin): " username
        username=${username:-admin}
        
        read -sp "请输入密码: " password
        echo ""
        
        echo ""
        echo "正在验证..."
        
        # 测试 API
        response=$(curl -s -X POST http://localhost:3000/api/user/login \
          -H "Content-Type: application/json" \
          -d "{\"username\":\"${username}\",\"password\":\"${password}\"}")
        
        # 检查响应
        if echo "$response" | grep -q '"success":true'; then
            echo -e "${GREEN}✅ 验证成功！${NC}"
            echo ""
            echo "响应信息:"
            echo "$response" | jq '.'
        else
            echo -e "${RED}❌ 验证失败${NC}"
            echo ""
            echo "响应信息:"
            echo "$response" | jq '.'
        fi
        ;;
    
    4)
        echo "退出"
        exit 0
        ;;
    
    *)
        echo -e "${RED}❌ 无效选择${NC}"
        exit 1
        ;;
esac

echo ""
