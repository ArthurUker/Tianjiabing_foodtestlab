@echo off
REM 🚀 Food Safety Testing System - Quick Setup Script (Windows)
REM 快速设置脚本 - 初始化开发环境 (Windows 版本)

setlocal enabledelayedexpansion
chcp 65001 > nul

echo.
echo 🍽️  Food Safety Testing System - 快速设置
echo ================================================
echo.

REM 检查 Node.js 和 npm
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 错误: Node.js 未安装。请先安装 Node.js 16+。
    exit /b 1
)

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 错误: npm 未安装。请先安装 npm。
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i

echo ✅ Node.js 版本: %NODE_VERSION%
echo ✅ npm 版本: %NPM_VERSION%
echo.

REM 检查 .env 文件
echo 🔧 检查环境配置...

if not exist "backend\.env" (
    echo ⚠️  警告: backend\.env 文件不存在
    echo 📝 请创建 backend\.env 文件并配置以下环境变量:
    echo.
    echo    DATABASE_URL="file:./prisma/foodtestlab.db"
    echo    JWT_SECRET=your_jwt_secret_key
    echo    CORS_ORIGIN=http://localhost:8081
    echo    NODE_ENV=development
    echo.
    pause
) else (
    echo ✅ backend\.env 文件已找到
)

REM 安装后端依赖
echo.
echo 📦 安装后端依赖...
cd backend
call npm install

if %errorlevel% neq 0 (
    echo ❌ 后端依赖安装失败
    exit /b 1
)

echo ✅ 后端依赖安装完成
echo.
cd ..

REM 提供测试账号信息
echo ================================================
echo 📝 测试账号信息：
echo ================================================
echo.
echo 🧪 自动创建的测试账号 (在后端启动时创建):
echo.
echo   账号 1：
echo     用户名: testuser
echo     邮箱: testuser@example.com
echo     密码: TestPass123!
echo.
echo   账号 2:
echo     用户名: qa_tester
echo     邮箱: qa@example.com
echo     密码: TestPass123!
echo.
echo   账号 3 (禁用测试):
echo     用户名: disabled_user
echo     邮箱: disabled@example.com
echo     密码: TestPass123!
echo     状态: 已禁用
echo.
echo ================================================
echo.

REM 提供后续操作指引
echo ✅ 快速设置完成！
echo.
echo 📋 后续步骤:
echo.
echo 1️⃣  启动后端服务 (在新的命令行窗口):
echo     cd backend ^&^& npm start
echo.
echo 2️⃣  后端成功启动后，测试用户将自动创建
echo     查看日志中的 '✅ 测试用户创建成功' 消息
echo.
echo 3️⃣  访问登录页面:
echo     http://localhost:3000/login.html
echo     或 file:///path/to/login.html
echo.
echo 4️⃣  使用测试账号登录 (例如):
echo     用户名: testuser
echo     密码: TestPass123!
echo.
echo 5️⃣  运行 Cypress E2E 测试 (可选):
echo     npm run cypress:open
echo.
echo 📚 更多信息，请查看:
echo     docs/LOGIN_TEST_GUIDE.md
echo     docs/QUICK_START_TESTING.md
echo.
echo 🔗 相关链接:
echo     登录: http://localhost:3000/login.html
echo     主页: http://localhost:3000/index.html
echo     健康检查: http://localhost:3000/health
echo.
echo ================================================
echo.
pause
