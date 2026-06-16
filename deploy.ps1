# =========================================================
# 自我更新检查（必须在所有逻辑之前，包括 Transcript）
# =========================================================
$selfPath      = $PSCommandPath
$selfRepoRoot  = "C:\ZhuHaiYiZhong"
$selfBranch    = "ZhuHaiYiZhong"

if (Test-Path (Join-Path $selfRepoRoot ".git")) {
    $hashBefore = (Get-FileHash $selfPath -Algorithm MD5).Hash

    git -C $selfRepoRoot fetch origin $selfBranch 2>&1 | Out-Null
    git -C $selfRepoRoot reset --hard "origin/$selfBranch" 2>&1 | Out-Null

    $hashAfter = (Get-FileHash $selfPath -Algorithm MD5).Hash

    if ($hashBefore -ne $hashAfter) {
        Write-Host "deploy.ps1 已更新，修正编码后切换到新版本执行..." -ForegroundColor Yellow
        # 确保新版文件是 UTF-8 with BOM，兼容 PowerShell 5.1
        $newContent = [System.IO.File]::ReadAllText($selfPath, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($selfPath, $newContent, [System.Text.UTF8Encoding]::new($true))
        & $selfPath @args
        exit $LASTEXITCODE
    }
}
# =========================================================
# 以下是正常部署逻辑
# =========================================================
$ErrorActionPreference = "Continue"
$startTime = Get-Date

function Log($msg)  { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Warn($msg) { Write-Host "警告: $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "错误: $msg" -ForegroundColor Red; exit 1 }

function Test-CommandExists($cmd) {
    $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Test-PortListening($port) {
    try {
        return Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
    } catch {
        return $null
    }
}

function Stop-PortProcess($port) {
    $connections = @(Test-PortListening $port)
    foreach ($conn in $connections) {
        if ($null -ne $conn.OwningProcess -and $conn.OwningProcess -gt 0) {
            try {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
                Write-Host "已强制结束占用端口 $port 的进程 PID=$($conn.OwningProcess)" -ForegroundColor Yellow
            } catch {
                Warn "无法结束占用端口 $port 的进程 PID=$($conn.OwningProcess)：$($_.Exception.Message)"
            }
        }
    }
}

function Invoke-GitFetchWithTimeout($repoRootPath, $branchName, $timeoutSeconds) {
    $arguments = @(
        "-C", $repoRootPath,
        "-c", "credential.interactive=never",
        "-c", "http.lowSpeedLimit=1000",
        "-c", "http.lowSpeedTime=30",
        "fetch", "--prune", "origin", $branchName
    )

    $process = Start-Process -FilePath "git" -ArgumentList $arguments -NoNewWindow -PassThru
    if (-not $process.WaitForExit($timeoutSeconds * 1000)) {
        try { $process.Kill() } catch {}
        return $false
    }

    return ($process.ExitCode -eq 0)
}

Log "珠海一中食品检验系统一键部署开始"

# =========================================================
# 0. 日志文件
# =========================================================

$logDir = Join-Path $env:TEMP "zhuhaiyizhong-deploy-logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir ("deploy-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $logFile -Append | Out-Null
Write-Host "部署日志将保存至: $logFile" -ForegroundColor Gray

# =========================================================
# 1. 基础配置
# =========================================================

$repoUrl      = "https://github.com/ArthurUker/Tianjiabing_foodtestlab.git"
$deployBranch = if ($env:DEPLOY_BRANCH) { $env:DEPLOY_BRANCH } else { "ZhuHaiYiZhong" }

$repoRoot     = if ($env:REPO_ROOT)     { $env:REPO_ROOT }     else { "C:\ZhuHaiYiZhong" }
$backendPath  = if ($env:BACKEND_PATH)  { $env:BACKEND_PATH }  else { Join-Path $repoRoot "backend" }
$frontendPath = if ($env:FRONTEND_PATH) { $env:FRONTEND_PATH } else { $repoRoot }
$nginxRoot    = if ($env:NGINX_ROOT)    { $env:NGINX_ROOT }    else { "C:\nginx" }

$frontendPort = if ($env:FRONTEND_PORT) { [int]$env:FRONTEND_PORT } else { 8082 }
$apiPort      = if ($env:API_PORT)      { [int]$env:API_PORT }      else { 3002 }
$pm2AppName   = if ($env:PM2_APP_NAME)  { $env:PM2_APP_NAME }       else { "zhuhaiyizhong-api" }
$dataPath     = if ($env:DATA_PATH)     { $env:DATA_PATH }          else { "D:\ZhuHaiYiZhong-data" }

$rdpmsFrontendPort = 8080; $rdpmsApiPort = 3000; $rdpmsPm2Name = "rdpms-backend"
$tjbFrontendPort   = 8081; $tjbApiPort   = 3001; $tjbPm2Name   = "foodtestlab-api"

Write-Host "项目根目录  : $repoRoot"
Write-Host "后端目录    : $backendPath"
Write-Host "前端目录    : $frontendPath"
Write-Host "Nginx 目录  : $nginxRoot"
Write-Host "数据目录    : $dataPath"
Write-Host "部署分支    : $deployBranch"
Write-Host "前端端口    : $frontendPort"
Write-Host "API 端口    : $apiPort"
Write-Host "PM2 名称    : $pm2AppName"

# =========================================================
# 2. 工具检查
# =========================================================

Log "检查基础工具"

foreach ($tool in @("git", "node", "npm")) {
    if (-not (Test-CommandExists $tool)) {
        Fail "未检测到 $tool，请先安装并加入 PATH"
    }
}

$nginxExe = Join-Path $nginxRoot "nginx.exe"
if (-not (Test-Path $nginxRoot)) { Fail "未找到 Nginx 目录: $nginxRoot" }
if (-not (Test-Path $nginxExe))  { Fail "未找到 nginx.exe: $nginxExe" }

Write-Host "Node 版本: $(node -v)"
Write-Host "npm  版本: $(npm -v)"
Write-Host "PM2  版本: $(npx pm2 -v 2>$null)"

# =========================================================
# 3. 三系统隔离检查
# =========================================================

Log "检查三系统隔离配置"

$usedPorts = @($rdpmsFrontendPort, $rdpmsApiPort, $tjbFrontendPort, $tjbApiPort)
if ($usedPorts -contains $frontendPort -or $usedPorts -contains $apiPort -or $frontendPort -eq $apiPort) {
    Fail "端口冲突：珠海一中端口必须避开 RDPMS 8080/3000 和田家炳 8081/3001。当前 FRONTEND_PORT=$frontendPort, API_PORT=$apiPort"
}

if ($pm2AppName -eq $rdpmsPm2Name -or $pm2AppName -eq $tjbPm2Name) {
    Fail "PM2 名称冲突：$pm2AppName 已被其他系统占用"
}

Ok "端口矩阵通过：RDPMS 8080/3000；田家炳 8081/3001；珠海一中 $frontendPort/$apiPort"
Ok "PM2 名称检查通过：$pm2AppName"

# =========================================================
# 4. Git 仓库处理
# =========================================================

Log "检查 Git 仓库"

if (-not (Test-Path $repoRoot)) {
    New-Item -ItemType Directory -Path $repoRoot -Force | Out-Null
}

Set-Location $repoRoot

if (-not (Test-Path (Join-Path $repoRoot ".git"))) {
    Log "当前目录不是 Git 仓库，开始克隆珠海一中分支代码"

    $items = Get-ChildItem -Force $repoRoot | Where-Object { $_.Name -ne "deploy.ps1" }
    if ($items.Count -gt 0) {
        Fail "当前目录不是 Git 仓库且目录非空。请清空目录后重新执行 deploy.ps1"
    }

    git clone -b $deployBranch $repoUrl .
    if ($LASTEXITCODE -ne 0) { Fail "Git clone 失败，请检查网络、仓库地址或分支名称" }
} else {
    Log "检测到已有 Git 仓库，准备拉取最新代码"

    $remoteUrl = git -C $repoRoot remote get-url origin 2>$null
    Write-Host "当前远程仓库: $remoteUrl"

    Log "停止珠海一中 PM2 后端，释放文件锁"
    npx pm2 stop $pm2AppName *> $null
    npx pm2 delete $pm2AppName *> $null
    Stop-PortProcess $apiPort
    Start-Sleep -Seconds 2

    Log "拉取最新代码（带网络重试机制）"
    $maxRetries = 3; $retryCount = 0; $fetchSuccess = $false

    while ($retryCount -lt $maxRetries) {
        Write-Host "正在执行 git fetch，尝试 $($retryCount + 1)/$maxRetries ..."
        $fetchSuccess = Invoke-GitFetchWithTimeout $repoRoot $deployBranch 45
        if ($fetchSuccess) { break }
        Warn "git fetch 超时或失败（45 秒），准备重试"
        $retryCount++
        Start-Sleep -Seconds 3
    }

    if (-not $fetchSuccess) {
        Warn "GitHub 连接失败，将使用本地已有代码继续部署"
    } else {
        git -C $repoRoot checkout $deployBranch
        git -C $repoRoot reset --hard "origin/$deployBranch"
        git -C $repoRoot clean -fd -e ".env" -e "*.db" -e "deploy.ps1" -e "backend/.env"
    }

    git -C $repoRoot log -1 --oneline
}

# =========================================================
# 5. 环境变量文件处理（含自动修正关键变量）
# =========================================================

Log "检查并修正环境变量文件"

$rootEnvPath    = Join-Path $repoRoot ".env"
$backendEnvPath = Join-Path $backendPath ".env"

# 如果根目录 .env 不存在，从 .env.example 复制
if (-not (Test-Path $rootEnvPath)) {
    $envExample = Join-Path $repoRoot ".env.example"
    if (Test-Path $envExample) {
        Copy-Item $envExample $rootEnvPath
        Warn "已从 .env.example 复制生成 .env"
    } else {
        Warn "未找到 .env 或 .env.example，将创建最小化 .env"
    }
}

# 如果 backend/.env 不存在，从根目录 .env 复制
if ((Test-Path $rootEnvPath) -and (Test-Path $backendPath) -and (-not (Test-Path $backendEnvPath))) {
    Copy-Item $rootEnvPath $backendEnvPath
    Warn "已将根目录 .env 复制到 backend/.env"
}

# 强制修正 backend/.env 中的关键变量（解决模板残留问题）
$backendEnvTarget = Join-Path $backendPath ".env"
if (-not (Test-Path $backendEnvTarget)) {
    New-Item -ItemType File -Path $backendEnvTarget -Force | Out-Null
}

$envText = [System.IO.File]::ReadAllText($backendEnvTarget, [System.Text.UTF8Encoding]::new($false))

# 修正 PORT
if ($envText -match '(?m)^PORT\s*=') {
    $envText = $envText -replace '(?m)^PORT\s*=.*$', "PORT=$apiPort"
} else {
    if ($envText -and -not $envText.EndsWith("`n")) { $envText += "`r`n" }
    $envText += "PORT=$apiPort`r`n"
}

# 修正 NODE_ENV
if ($envText -match '(?m)^NODE_ENV\s*=') {
    $envText = $envText -replace '(?m)^NODE_ENV\s*=.*$', 'NODE_ENV=production'
} else {
    $envText += "NODE_ENV=production`r`n"
}

# 写回（UTF-8 with BOM，兼容 PowerShell 5.1）
[System.IO.File]::WriteAllText($backendEnvTarget, $envText, [System.Text.UTF8Encoding]::new($true))
Ok "backend/.env 关键变量已修正：PORT=$apiPort, NODE_ENV=production"

# 验证
$envCheck = [System.IO.File]::ReadAllText($backendEnvTarget, [System.Text.UTF8Encoding]::new($false))
if ($envCheck -notmatch "PORT\s*=\s*$apiPort") { Warn "backend/.env PORT 修正后仍未检测到 $apiPort，请手动确认" }
if ($envCheck -notmatch "CORS_ORIGIN")          { Warn "backend/.env 中未检测到 CORS_ORIGIN，请确认跨域配置" }

# =========================================================
# 6. 后端依赖、Prisma、数据库
# =========================================================

Log "检查后端目录"

if (-not (Test-Path $backendPath))   { Fail "未找到后端目录: $backendPath" }
Set-Location $backendPath
if (-not (Test-Path "package.json")) { Fail "后端目录下未找到 package.json" }

Log "后端依赖安装"

if (Test-Path "package-lock.json") {
    try {
        npm ci
    } catch {
        Warn "npm ci 在 Windows 上遇到文件占用，改用 npm install --no-audit --no-fund"
        Stop-PortProcess $apiPort
        npm install --no-audit --no-fund
    }
} else {
    Warn "未找到 package-lock.json，改用 npm install --no-audit --no-fund"
    npm install --no-audit --no-fund
}
if ($LASTEXITCODE -ne 0) { Fail "后端依赖安装失败" }

Log "Prisma 生成与迁移"

if (Test-Path "prisma") {
    if (-not (Test-Path $dataPath)) {
        New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
        Ok "已创建数据目录: $dataPath"
    } else {
        Ok "数据目录已存在: $dataPath"
    }

    $dbFile = Join-Path $dataPath "zhuhaiyizhong.db"
    $dbUrl  = "file:" + ($dbFile -replace "\\", "/")

    # 修正 DATABASE_URL
    $envText2 = [System.IO.File]::ReadAllText($backendEnvTarget, [System.Text.UTF8Encoding]::new($false))
    if ($envText2 -match '(?m)^DATABASE_URL\s*=') {
        $envText2 = $envText2 -replace '(?m)^DATABASE_URL\s*=.*$', "DATABASE_URL=`"$dbUrl`""
    } else {
        $envText2 += "DATABASE_URL=`"$dbUrl`"`r`n"
    }
    [System.IO.File]::WriteAllText($backendEnvTarget, $envText2, [System.Text.UTF8Encoding]::new($true))
    Ok "DATABASE_URL 已设置为: $dbUrl"

    npx prisma generate
    if ($LASTEXITCODE -ne 0) { Fail "Prisma generate 失败" }

    npx prisma db push --accept-data-loss
    if ($LASTEXITCODE -ne 0) { Fail "Prisma db push 失败" }
    Ok "数据库 schema 同步完成"

    if (Test-Path "prisma\seed.js") {
        Write-Host "检测到 seed.js，执行种子数据初始化..." -ForegroundColor Cyan
        node prisma/seed.js
        if ($LASTEXITCODE -ne 0) {
            Warn "seed.js 执行失败，请手动运行: node backend/prisma/seed.js"
        } else {
            Ok "种子数据初始化完成"
        }
    }
} else {
    Warn "未检测到 prisma 目录，跳过 Prisma generate 和 db push"
}

# =========================================================
# 7. PM2 启动或重启后端
# =========================================================

Log "PM2 启动或重启珠海一中后端"

$pm2Output = npx pm2 list 2>$null | Out-String

if ($pm2Output -match [regex]::Escape($pm2AppName)) {
    npx pm2 restart $pm2AppName --update-env
} else {
    if      (Test-Path "src/index.js")  { npx pm2 start src/index.js  --name $pm2AppName --cwd $backendPath --time }
    elseif  (Test-Path "dist/index.js") { npx pm2 start dist/index.js --name $pm2AppName --cwd $backendPath --time }
    elseif  (Test-Path "dist/main.js")  { npx pm2 start dist/main.js  --name $pm2AppName --cwd $backendPath --time }
    elseif  (Test-Path "server.js")     { npx pm2 start server.js     --name $pm2AppName --cwd $backendPath --time }
    else                                { npx pm2 start npm           --name $pm2AppName --cwd $backendPath -- start }
}

if ($LASTEXITCODE -ne 0) { Fail "PM2 启动或重启后端失败" }
npx pm2 save

# =========================================================
# 8. API 健康检查（在前端构建之前，趁后端启动窗口期检查）
# =========================================================

Log "API 健康检查（后端启动等待）"

$healthUrl = "http://127.0.0.1:$apiPort/api/health"
$healthOk  = $false

for ($i = 1; $i -le 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400) {
            Ok "API 健康检查通过（第 $i 次尝试）: $healthUrl  状态码: $($resp.StatusCode)"
            $healthOk = $true
            break
        }
    } catch {
        Write-Host "等待后端启动... ($i/30)" -ForegroundColor Gray
        Start-Sleep -Seconds 2
    }
}

if (-not $healthOk) {
    Warn "健康检查超时（60 秒）。服务可能仍在启动，继续执行前端构建，请稍后检查: npx pm2 logs $pm2AppName"
}

# =========================================================
# 9. 前端依赖安装与构建
# =========================================================

Log "前端依赖安装和构建"

if (-not (Test-Path $frontendPath))  { Fail "未找到前端目录: $frontendPath" }
Set-Location $frontendPath
if (-not (Test-Path "package.json")) { Fail "前端目录下未找到 package.json" }

if (Test-Path "package-lock.json") {
    npm ci
} else {
    Warn "未找到 package-lock.json，改用 npm install"
    npm install
}
if ($LASTEXITCODE -ne 0) { Fail "前端依赖安装失败" }

$pkgJson = Get-Content (Join-Path $frontendPath "package.json") -Raw | ConvertFrom-Json
if ($pkgJson.scripts -and $pkgJson.scripts.build) {
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "前端构建失败" }
} else {
    Warn "未检测到 build 脚本，跳过前端构建"
}

$distIndexPath = Join-Path $frontendPath "dist\index.html"
if (Test-Path $distIndexPath) {
    Ok "前端构建验证通过：dist/index.html 存在"
} else {
    Fail "前端构建异常：dist/index.html 不存在，请检查 build 输出"
}

# =========================================================
# 10. Nginx 三系统配置写入与重载
# =========================================================

Log "Nginx 配置写入与重载"

Set-Location $nginxRoot

$nginxConfPath = Join-Path $nginxRoot "conf\nginx.conf"

$fullNginxConf = @"
worker_processes  1;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;

    client_body_temp_path C:/nginx/temp/client_body_temp;
    proxy_temp_path       C:/nginx/temp/proxy_temp;
    fastcgi_temp_path     C:/nginx/temp/fastcgi_temp;
    uwsgi_temp_path       C:/nginx/temp/uwsgi_temp;
    scgi_temp_path        C:/nginx/temp/scgi_temp;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript application/xml+rss application/xml image/svg+xml;
    gzip_min_length 1024;

    # RDPMS 系统，端口 8080
    server {
        listen 8080;
        server_name _;
        root  C:/rdpms/rdpms-system/frontend/dist;
        index index.html;

        location / {
            try_files `$uri `$uri/ /index.html;
        }

        location /api/ {
            proxy_pass         http://127.0.0.1:3000;
            proxy_http_version 1.1;
            proxy_set_header   Host            `$host;
            proxy_set_header   X-Real-IP       `$remote_addr;
            proxy_set_header   X-Forwarded-For `$proxy_add_x_forwarded_for;
            proxy_read_timeout 60s;
        }
    }

    # 田家炳食品检验系统，端口 8081
    server {
        listen 8081;
        server_name _;
        root  C:/foodtestlab/dist;
        index index.html;

        location / {
            try_files `$uri `$uri/ /index.html;
        }

        location /api/ {
            proxy_pass         http://127.0.0.1:3001;
            proxy_http_version 1.1;
            proxy_set_header   Host            `$host;
            proxy_set_header   X-Real-IP       `$remote_addr;
            proxy_set_header   X-Forwarded-For `$proxy_add_x_forwarded_for;
            proxy_read_timeout 60s;
        }
    }

    # 珠海一中食品检验系统，端口 8082
    server {
        listen 8082;
        server_name _;
        root  C:/ZhuHaiYiZhong/dist;
        index index.html;

        location / {
            try_files `$uri `$uri/ /index.html;
        }

        location /api/ {
            proxy_pass            http://127.0.0.1:3002;
            proxy_http_version    1.1;
            proxy_set_header      Host              `$host;
            proxy_set_header      X-Real-IP         `$remote_addr;
            proxy_set_header      X-Forwarded-For   `$proxy_add_x_forwarded_for;
            proxy_set_header      X-Forwarded-Proto `$scheme;
            proxy_connect_timeout 10s;
            proxy_send_timeout    30s;
            proxy_read_timeout    30s;
        }
    }
}
"@

[System.IO.File]::WriteAllText($nginxConfPath, $fullNginxConf, [System.Text.UTF8Encoding]::new($false))
Ok "Nginx 三系统配置已写入: $nginxConfPath"

.\nginx.exe -t
if ($LASTEXITCODE -ne 0) { Fail "Nginx 配置检查失败，请检查 $nginxConfPath" }

.\nginx.exe -s reload
if ($LASTEXITCODE -ne 0) {
    Warn "Nginx reload 返回异常。若 Nginx 未启动，请先执行: C:\nginx\nginx.exe"
}

# =========================================================
# 完成
# =========================================================

$elapsed = (Get-Date) - $startTime

Log "珠海一中食品检验系统部署完成"

Ok ("耗时: {0} 秒" -f [math]::Round($elapsed.TotalSeconds, 1))
Write-Host ""
Write-Host "请继续检查以下项目:" -ForegroundColor Cyan
Write-Host "1. PM2 状态:     npx pm2 list"
Write-Host "2. 后端日志:     npx pm2 logs $pm2AppName"
Write-Host "3. 健康检查:     Invoke-WebRequest -Uri `"$healthUrl`" -UseBasicParsing"
Write-Host "4. 公网访问:     http://你的公网IP:$frontendPort"
Write-Host "5. 部署日志:     $logFile"
Write-Host ""
Write-Host "三系统隔离状态:" -ForegroundColor Cyan
Write-Host "   RDPMS      : 前端 8080  API 3000  PM2 rdpms-backend"
Write-Host "   田家炳     : 前端 8081  API 3001  PM2 foodtestlab-api"
Write-Host "   珠海一中   : 前端 $frontendPort  API $apiPort  PM2 $pm2AppName"

Stop-Transcript | Out-Null
exit 0