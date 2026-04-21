@echo off
REM 🔍 診断 Admin 账号问题 (Windows)

setlocal enabledelayedexpansion
chcp 65001 > nul

echo.
echo ╔════════════════════════════════════════╗
echo ║  🔍 诊断 Admin 账号问题                 ║
echo ╚════════════════════════════════════════╝
echo.

REM 检查后端是否运行
echo 1️⃣  检查后端是否运行...
curl -s http://localhost:3000/health >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 后端未运行！请先启动:
    echo    cd backend ^&^& npm start
    pause
    exit /b 1
)
echo ✅ 后端运行正常
echo.

echo 2️⃣  检查 admin 账号是否存在...
echo.

REM 测试 admin 登录
curl -s -X POST http://localhost:3000/api/user/login ^
  -H "Content-Type: application/json" ^
  -d "{\"username\":\"admin\",\"password\":\"8888\"}" > response.json

echo API 响应:
type response.json
echo.

REM 检查响应是否成功
findstr /M "success.*true" response.json >nul
if %errorlevel% equ 0 (
    echo ✅ Admin 账号存在且密码正确！
    del response.json
    pause
    exit /b 0
)

findstr /M "用户不存在" response.json >nul
if %errorlevel% equ 0 (
    echo ❌ Admin 账号不存在
    echo.
    echo 解决方案:
    echo 1. 检查后端初始化日志 (查找 '✅ 用户创建成功')
    echo 2. 重启后端服务:
    echo    cd backend ^&^& npm start
    echo 3. 如果仍不存在，手动创建 SQL (在 Supabase 中运行):
    echo.
    echo    INSERT INTO users (username, email, password_hash, full_name, role, status)
    echo    VALUES ('admin', 'admin@foodlab.com', '$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m', '系统管理员', 'admin', 'active')
    echo    ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash;
    echo.
    del response.json
    pause
    exit /b 1
)

findstr /M "密码错误" response.json >nul
if %errorlevel% equ 0 (
    echo ❌ Admin 账号存在但密码错误
    echo.
    echo 解决方案:
    echo 1. 检查密码是否为 8888
    echo 2. 重置密码哈希:
    echo    cd backend
    echo    admin-setup.bat
    del response.json
    pause
    exit /b 1
)

echo ❌ 未知错误
type response.json
del response.json
pause
exit /b 1
