@echo off
REM 🔐 Admin Account Setup Script (Windows)
REM 快速创建或重置 admin 账号

setlocal enabledelayedexpansion
chcp 65001 > nul

echo.
echo ╔════════════════════════════════════════╗
echo ║  🔐 Admin Account Setup Tool           ║
echo ║  快速创建/重置管理员账号              ║
echo ╚════════════════════════════════════════╝
echo.

REM 检查是否在 backend 目录
if not exist "package.json" (
    echo ❌ 错误: 请在 backend 目录中运行此脚本
    pause
    exit /b 1
)

:menu
echo.
echo 📝 Admin Account Setup
echo.
echo 1. 生成密码哈希
echo 2. 创建/重置 admin 账号
echo 3. 验证账号
echo 4. 退出
echo.

set /p choice="请选择 (1-4): "

if "%choice%"=="1" (
    goto generate_hash
) else if "%choice%"=="2" (
    goto create_admin
) else if "%choice%"=="3" (
    goto verify_account
) else if "%choice%"=="4" (
    echo 退出
    exit /b 0
) else (
    echo ❌ 无效选择
    goto menu
)

:generate_hash
echo.
echo 📝 生成密码哈希
echo.
set /p password="请输入密码 (默认: 8888): "
if "%password%"=="" set password=8888

echo.
echo 正在生成哈希值...
echo.

for /f "tokens=*" %%i in ('node -e "const bcryptjs = require('bcryptjs'); bcryptjs.hash('%password%', 10, (err, hash) => { if(err) console.error(err); else console.log(hash); });"') do set hash=%%i

echo ✅ 生成成功
echo.
echo 密码: %password%
echo 哈希值:
echo %hash%
echo.
echo 💡 提示: 复制上面的哈希值，在 Supabase 中更新 users 表
echo SQL 命令:
echo UPDATE users SET password_hash = '%hash%' WHERE username = 'admin';
echo.

pause
goto menu

:create_admin
echo.
echo 🔧 创建/重置 Admin 账号
echo.

set /p password="请输入 admin 密码 (默认: 8888): "
if "%password%"=="" set password=8888

set /p email="请输入 admin 邮箱 (默认: admin@foodlab.com): "
if "%email%"=="" set email=admin@foodlab.com

set /p fullname="请输入 admin 全名 (默认: 系统管理员): "
if "%fullname%"=="" set fullname=系统管理员

echo.
echo 正在生成密码哈希...

for /f "tokens=*" %%i in ('node -e "const bcryptjs = require('bcryptjs'); bcryptjs.hash('%password%', 10, (err, hash) => { if(err) console.error(err); else console.log(hash); });"') do set hash=%%i

if "%hash%"=="" (
    echo ❌ 哈希生成失败
    pause
    goto menu
)

echo.
echo 账号信息:
echo   用户名: admin
echo   密码: %password%
echo   邮箱: %email%
echo   全名: %fullname%
echo   角色: admin
echo.

set /p confirm="确认创建/更新? (y/n): "
if not "%confirm%"=="y" (
    echo 已取消
    pause
    goto menu
)

echo.
echo 💡 请在 Supabase SQL Editor 中运行以下命令:
echo.
echo INSERT INTO users (username, email, password_hash, full_name, role, status)
echo VALUES ('admin', '%email%', '%hash%', '%fullname%', 'admin', 'active')
echo ON CONFLICT (username) DO UPDATE SET
echo   password_hash = EXCLUDED.password_hash,
echo   email = EXCLUDED.email,
echo   full_name = EXCLUDED.full_name;
echo.
echo ✅ 或者重启后端服务会自动更新
echo.

pause
goto menu

:verify_account
echo.
echo 🔍 验证 Admin 账号
echo.

set /p username="请输入 admin 用户名 (默认: admin): "
if "%username%"=="" set username=admin

set /p password="请输入密码: "

echo.
echo 正在验证...
echo.

REM 测试 API
curl -X POST http://localhost:3000/api/user/login ^
  -H "Content-Type: application/json" ^
  -d "{\"username\":\"%username%\",\"password\":\"%password%\"}"

echo.
pause
goto menu
