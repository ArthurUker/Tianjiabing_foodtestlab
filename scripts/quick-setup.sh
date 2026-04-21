#!/bin/bash

# 🚀 Food Safety Testing System - Quick Setup Script
# 快速设置脚本 - 初始化开发环境

echo "🍽️  Food Safety Testing System - 快速设置"
echo "================================================"
echo ""

# 检查 Node.js 和 npm
if ! command -v node &> /dev/null; then
    echo "❌ 错误: Node.js 未安装。请先安装 Node.js 16+。"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "❌ 错误: npm 未安装。请先安装 npm。"
    exit 1
fi

echo "✅ Node.js 版本: $(node --version)"
echo "✅ npm 版本: $(npm --version)"
echo ""

# 检查 .env 文件
echo "🔧 检查环境配置..."

if [ ! -f "backend/.env" ]; then
    echo "⚠️  警告: backend/.env 文件不存在"
    echo "📝 请创建 backend/.env 文件并配置以下环境变量:"
    echo ""
    echo "   SUPABASE_URL=your_supabase_url"
    echo "   SUPABASE_KEY=your_supabase_anon_key"
    echo "   JWT_SECRET=your_jwt_secret_key"
    echo "   CORS_ORIGIN=http://localhost:3000"
    echo "   NODE_ENV=development"
    echo ""
    read -p "按 Enter 键继续（假设已配置）..."
else
    echo "✅ backend/.env 文件已找到"
fi

# 安装后端依赖
echo ""
echo "📦 安装后端依赖..."
cd backend
npm install

if [ $? -ne 0 ]; then
    echo "❌ 后端依赖安装失败"
    exit 1
fi

echo "✅ 后端依赖安装完成"
echo ""

# 启动后端服务
echo "🚀 启动后端服务..."
echo "📝 为了测试，后端将自动创建测试用户"
echo ""

# 检查是否存在 package.json 中的启动脚本
if grep -q '"start"' package.json; then
    echo "💡 在新的终端窗口中运行以下命令启动后端："
    echo ""
    echo "   cd backend && npm start"
    echo ""
    echo "⏳ 等待后端启动完成（约 3-5 秒）..."
    echo ""
else
    echo "❌ 错误: 未找到启动脚本。请检查 backend/package.json"
    exit 1
fi

# 提供测试账号信息
echo "================================================"
echo "📝 测试账号信息："
echo "================================================"
echo ""
echo "🧪 自动创建的测试账号 (在后端启动时创建):"
echo ""
echo "  账号 1："
echo "    用户名: testuser"
echo "    邮箱: testuser@example.com"
echo "    密码: TestPass123!"
echo ""
echo "  账号 2:"
echo "    用户名: qa_tester"
echo "    邮箱: qa@example.com"
echo "    密码: TestPass123!"
echo ""
echo "  账号 3 (禁用测试):"
echo "    用户名: disabled_user"
echo "    邮箱: disabled@example.com"
echo "    密码: TestPass123!"
echo "    状态: 已禁用"
echo ""
echo "================================================"
echo ""

# 提供后续操作指引
echo "✅ 快速设置完成！"
echo ""
echo "📋 后续步骤:"
echo ""
echo "1️⃣  启动后端服务 (在新的终端窗口):"
echo "     cd backend && npm start"
echo ""
echo "2️⃣  后端成功启动后，测试用户将自动创建"
echo "     查看日志中的 '✅ 测试用户创建成功' 消息"
echo ""
echo "3️⃣  访问登录页面:"
echo "     http://localhost:3000/login.html"
echo "     或 file:///path/to/login.html"
echo ""
echo "4️⃣  使用测试账号登录 (例如):"
echo "     用户名: testuser"
echo "     密码: TestPass123!"
echo ""
echo "5️⃣  运行 Cypress E2E 测试 (可选):"
echo "     npm run cypress:open"
echo ""
echo "📚 更多信息，请查看:"
echo "    docs/LOGIN_TEST_GUIDE.md"
echo "    docs/QUICK_START_TESTING.md"
echo ""
echo "🔗 相关链接:"
echo "    登录: http://localhost:3000/login.html"
echo "    主页: http://localhost:3000/index.html"
echo "    健康检查: http://localhost:3000/health"
echo ""
echo "================================================"
