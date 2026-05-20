$ErrorActionPreference = "Continue"
$startTime = Get-Date

function Log($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Info($msg) { Write-Host $msg -ForegroundColor Gray }
function Ok($msg) { Write-Host $msg -ForegroundColor Green }
function WarnMsg($msg) { Write-Host $msg -ForegroundColor Yellow }
function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# ==================== 配置（可通过环境变量覆盖） ====================
$repoRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { "C:\foodtestlab" }
$backendPath = if ($env:BACKEND_PATH) { $env:BACKEND_PATH } else { Join-Path $repoRoot "backend" }
$frontendPath = if ($env:FRONTEND_PATH) { $env:FRONTEND_PATH } else { $repoRoot }
$nginxRoot = if ($env:NGINX_ROOT) { $env:NGINX_ROOT } else { "C:\nginx" }
$branchName = if ($env:DEPLOY_BRANCH) { $env:DEPLOY_BRANCH } else { "runon_tencentcloud" }

# 食品系统固定隔离端口（避免与 RDPMS 冲突）
$frontendPort = if ($env:FRONTEND_PORT) { [int]$env:FRONTEND_PORT } else { 8081 }
$apiPort = if ($env:API_PORT) { [int]$env:API_PORT } else { 3001 }
$pm2AppName = if ($env:PM2_APP_NAME) { $env:PM2_APP_NAME } else { "foodtestlab-api" }

# RDPMS 参考系统占用（用于冲突检查）
$rdpmsFrontendPort = 8080
$rdpmsApiPort = 3000
$rdpmsPm2Name = "rdpms-backend"

$logDir = Join-Path $env:TEMP "foodtestlab-deploy-logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir ("deploy-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $logFile -Append | Out-Null

function Assert-Tool($name, $tip) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        WarnMsg "缺少命令: $name。$tip"
        return $false
    }
    return $true
}

function Test-PortListening($port) {
    try {
        $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
        return $conn
    } catch {
        return $null
    }
}

function Preflight-ConflictCheck {
    Log "部署前冲突检查（双系统隔离）"

    if ($frontendPort -eq $rdpmsFrontendPort -or $frontendPort -eq $rdpmsApiPort -or
        $apiPort -eq $rdpmsFrontendPort -or $apiPort -eq $rdpmsApiPort -or
        $frontendPort -eq $apiPort) {
        Fail "端口冲突：食品系统端口必须与 RDPMS(8080/3000)及自身端口隔离。当前 FRONTEND_PORT=$frontendPort, API_PORT=$apiPort"
    }
    Ok "端口矩阵通过：食品系统 $frontendPort/$apiPort 与 RDPMS 8080/3000 已隔离"

    $pm2Output = ""
    if (Get-Command pm2 -ErrorAction SilentlyContinue) {
        $pm2Output = (pm2 list 2>$null | Out-String)
        if ($pm2AppName -eq $rdpmsPm2Name) {
            Fail "PM2 应用名冲突：PM2_APP_NAME 不能为 $rdpmsPm2Name"
        }
        Ok "PM2 名称检查通过：$pm2AppName 与 $rdpmsPm2Name 已隔离"
    } else {
        WarnMsg "未检测到 pm2，跳过 PM2 名称冲突检查"
    }

    $fConn = Test-PortListening -port $frontendPort
    $aConn = Test-PortListening -port $apiPort
    if ($fConn) { WarnMsg "端口 $frontendPort 当前被占用，部署后请确认为 nginx 使用" }
    if ($aConn) { WarnMsg "端口 $apiPort 当前被占用，部署后请确认为 Node API 使用" }
}

Log "识别项目结构"
if (-not (Test-Path (Join-Path $repoRoot ".git"))) {
    Stop-Transcript | Out-Null
    Fail "未找到 Git 仓库: $repoRoot"
}
if (-not (Test-Path $backendPath)) {
    Stop-Transcript | Out-Null
    Fail "未找到后端目录: $backendPath"
}
if (-not (Test-Path $frontendPath)) {
    Stop-Transcript | Out-Null
    Fail "未找到前端目录: $frontendPath"
}

Log "工具检查"
$null = Assert-Tool "git" "请先安装 Git"
$null = Assert-Tool "node" "请先安装 Node.js"
$null = Assert-Tool "npm" "请先安装 npm"
$null = Assert-Tool "pm2" "建议 npm i -g pm2"

Preflight-ConflictCheck

Log "先停止 PM2 后端（释放文件锁）"
pm2 stop $pm2AppName 2>$null
Start-Sleep -Seconds 2

Log "拉取最新代码 (带网络重试机制)"
$maxRetries = 3
$retryCount = 0
$fetchSuccess = $false

while ($retryCount -lt $maxRetries) {
    Write-Host "正在执行 git fetch (尝试 $($retryCount + 1)/$maxRetries)..."
    git -C $repoRoot fetch origin 2>&1
    if ($LASTEXITCODE -eq 0) {
        $fetchSuccess = $true
        break
    }
    $retryCount++
    Start-Sleep -Seconds 3
}

if (-not $fetchSuccess) {
    WarnMsg "警告: GitHub 连接失败，将使用本地已有代码继续部署。"
}

git -C $repoRoot reset --hard ("origin/{0}" -f $branchName)
if ($LASTEXITCODE -ne 0) {
    Stop-Transcript | Out-Null
    Fail "git reset 失败，请确认分支存在：$branchName"
}

git -C $repoRoot clean -fd -e "**/.env" -e "*.db" -e "deploy.ps1"
git -C $repoRoot log -1 --oneline

Log "后端依赖安装"
Set-Location $backendPath
Write-Host "清理旧 node_modules..." -ForegroundColor Yellow
Remove-Item -Recurse -Force ".\node_modules" -ErrorAction SilentlyContinue
Remove-Item -Force ".\package-lock.json" -ErrorAction SilentlyContinue
npm ci
if ($LASTEXITCODE -ne 0) {
    WarnMsg "npm ci 失败，尝试 npm install..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Stop-Transcript | Out-Null
        Fail "后端依赖安装失败"
    }
}

Log "Prisma 生成和迁移"
if (Test-Path ".\prisma") {
    npx prisma generate
    if ($LASTEXITCODE -ne 0) { WarnMsg "prisma generate 失败，继续部署" }

    # 与参考脚本一致使用 migrate deploy，避免开发环境 db push 语义
    npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { WarnMsg "prisma migrate deploy 失败，请检查数据库连接与迁移文件" }
} else {
    WarnMsg "未检测到 prisma 目录，跳过迁移"
}

Log "PM2 重启后端"
$pm2Output = pm2 list 2>$null | Out-String
if ($pm2Output -match [regex]::Escape($pm2AppName)) {
    pm2 restart $pm2AppName
} else {
    pm2 start server.js --name $pm2AppName --cwd $backendPath --time
}
pm2 save

Log "前端依赖安装和构建"
Set-Location $frontendPath
Remove-Item -Recurse -Force ".\node_modules" -ErrorAction SilentlyContinue
Remove-Item -Force ".\package-lock.json" -ErrorAction SilentlyContinue
npm ci
if ($LASTEXITCODE -ne 0) {
    WarnMsg "前端 npm ci 失败，尝试 npm install..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Stop-Transcript | Out-Null
        Fail "前端依赖安装失败"
    }
}

$pkg = Join-Path $frontendPath "package.json"
if (Test-Path $pkg) {
    $pkgJson = Get-Content $pkg -Raw | ConvertFrom-Json
    if ($pkgJson.scripts -and $pkgJson.scripts.build) {
        npm run build
        if ($LASTEXITCODE -ne 0) { WarnMsg "前端构建失败，请检查 build 脚本" }
    } else {
        WarnMsg "未检测到 build 脚本，跳过前端构建"
    }
}

Log "Nginx 重载配置"
$nginxExe = Join-Path $nginxRoot "nginx.exe"
if (Test-Path $nginxExe) {
    Set-Location $nginxRoot
    .\nginx.exe -t
    if ($LASTEXITCODE -eq 0) {
        .\nginx.exe -s reload
    } else {
        WarnMsg "Nginx 配置检测失败，已跳过 reload"
    }
} else {
    WarnMsg "未找到 nginx.exe（$nginxExe），请确认 Nginx 安装路径"
}

Log "健康检查"
$healthOk = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/health" -f $apiPort) -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400) {
            $healthOk = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 2
    }
}
if ($healthOk) {
    Ok "API 健康检查通过"
} else {
    WarnMsg "健康检查超时，服务可能仍在启动"
}

$elapsed = (Get-Date) - $startTime
Log ("部署完成！耗时 {0} 秒" -f [math]::Round($elapsed.TotalSeconds, 1))
Info ("前端地址: http://<你的公网IP>:{0}" -f $frontendPort)
Info ("API 地址: http://<你的公网IP>:{0}/api" -f $frontendPort)
Info ("内部 API: http://127.0.0.1:{0}" -f $apiPort)
Info ("PM2 应用名: {0}" -f $pm2AppName)
Info ("日志文件: {0}" -f $logFile)

Stop-Transcript | Out-Null
exit 0
