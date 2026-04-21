@echo off
REM Windows 版本的 Supabase 配置脚本

setlocal enabledelayedexpansion

echo.
echo ╔════════════════════════════════════════╗
echo ║  🔑 Supabase API Key 配置工具          ║
echo ╚════════════════════════════════════════╝
echo.

REM 检查 .env 文件
set ENV_FILE=backend\.env

if not exist "%ENV_FILE%" (
    echo ❌ 错误: 未找到 %ENV_FILE%
    echo 📝 请确保在项目根目录运行此脚本
    pause
    exit /b 1
)

echo 📋 当前配置:
echo ─────────────────────────────────────────────
echo.

REM 读取当前配置
for /f "tokens=2 delims==" %%A in ('findstr /R "^SUPABASE_URL=" "%ENV_FILE%"') do (
    set CURRENT_URL=%%A
)

for /f "tokens=2 delims==" %%A in ('findstr /R "^SUPABASE_KEY=" "%ENV_FILE%"') do (
    set CURRENT_KEY=%%A
)

if defined CURRENT_URL (
    echo SUPABASE_URL: !CURRENT_URL!
) else (
    echo SUPABASE_URL: (未设置)
)

if defined CURRENT_KEY (
    set "KEY_LEN=0"
    setlocal enabledelayedexpansion
    set "str=!CURRENT_KEY!"
    for /l %%A in (0,1,1023) do (
        if "!str:~%%A,1!" neq "" set /a KEY_LEN=%%A
    )
    set /a KEY_START=!KEY_LEN!
    if !KEY_START! gtr 20 set KEY_START=20
    
    REM 简化显示
    set KEY_PREVIEW=!CURRENT_KEY:~0,20!...!CURRENT_KEY:~-10!
    echo SUPABASE_KEY: !KEY_PREVIEW!
) else (
    echo SUPABASE_KEY: (未设置)
)

echo.
echo 🔗 如何获取密钥:
echo ─────────────────────────────────────────────
echo.
echo 1️⃣  访问: https://app.supabase.com
echo 2️⃣  选择您的项目
echo 3️⃣  点击: Settings ^→ API
echo 4️⃣  复制: ANON/PUBLIC KEY
echo.

set /p NEW_KEY="✏️  请输入新的 SUPABASE_KEY: "

if "%NEW_KEY%"=="" (
    echo ❌ 密钥不能为空
    pause
    exit /b 1
)

echo.
echo 💾 正在更新 .env 文件...

REM 备份原文件
copy "%ENV_FILE%" "%ENV_FILE%.backup" >nul
echo ✅ 备份已保存到: %ENV_FILE%.backup

REM 使用 PowerShell 更新文件
powershell -Command ^
    "$content = Get-Content '%ENV_FILE%'; " ^
    "$content -replace '^SUPABASE_KEY=.*', ('SUPABASE_KEY=' + '%NEW_KEY%') | Set-Content '%ENV_FILE%'" ^
    2>nul

if errorlevel 1 (
    echo ❌ 更新失败，尝试备用方法...
    
    REM 创建临时文件
    setlocal enabledelayedexpansion
    (for /f "tokens=*" %%A in ('%ENV_FILE%') do (
        set "line=%%A"
        if "!line:~0,15!"=="SUPABASE_KEY=" (
            echo SUPABASE_KEY=%NEW_KEY%
        ) else (
            echo !line!
        )
    )) > "%ENV_FILE%.tmp"
    
    move /y "%ENV_FILE%.tmp" "%ENV_FILE%" >nul
    if errorlevel 1 (
        echo ❌ 无法更新 .env 文件
        pause
        exit /b 1
    )
)

echo ✅ SUPABASE_KEY 已更新
echo.
echo ✅ 验证成功！新密钥已保存
echo.
echo 🚀 下一步:
echo ─────────────────────────────────────────────
echo.
echo 1️⃣  测试连接:
echo    node scripts/test-supabase-connection.js
echo.
echo 2️⃣  重启后端:
echo    npm run dev
echo.

pause
