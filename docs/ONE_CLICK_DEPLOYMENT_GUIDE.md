# 食品系统一键部署操作指南（Windows 腾讯云）

本指南说明如何在 Windows 腾讯云服务器使用 PowerShell 脚本一键部署食品检验系统，并确保与 RDPMS 系统无冲突运行。

## 1. 双系统隔离约定（必须遵守）

- 食品系统前端端口：8081
- 食品系统 API 端口：3001
- 食品系统 PM2 名称：foodtestlab-api

- RDPMS 前端端口：8080
- RDPMS API 端口：3000
- RDPMS PM2 名称：rdpms-backend

部署脚本已内置冲突检查，若端口或 PM2 名称冲突会直接中止。

## 2. 前置条件

在 Windows 服务器安装：
- Git
- Node.js（建议 18+ 或 20 LTS）
- npm
- PM2（全局）
- Nginx for Windows

建议目录：
- 代码目录：C:\foodtestlab
- Nginx 目录：C:\nginx

## 3. 首次拉取代码

```powershell
cd C:\
git clone -b runon_tencentcloud https://github.com/ArthurUker/Tianjiabing_foodtestlab.git foodtestlab
cd C:\foodtestlab
```

## 4. 配置环境变量

在项目根目录复制并编辑环境配置：

```powershell
copy .env.example .env
notepad .env
```

关键项：
- PORT=3001
- SERVE_STATIC=false
- CORS_ORIGIN=http://<你的公网IP>:8081
- SUPABASE_URL=...
- SUPABASE_KEY=...

## 5. 一键部署

执行：

```powershell
cd C:\foodtestlab
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

脚本会自动执行：
1. 工具检查
2. 双系统冲突检查（8081/3001 与 8080/3000 隔离）
3. 停止 foodtestlab-api 释放文件锁
4. Git 拉取（3 次重试）
5. 后端依赖安装
6. Prisma 生成与迁移
7. PM2 启动/重启
8. 前端依赖安装与构建
9. Nginx 配置检查与重载
10. 健康检查

## 6. 可选环境变量覆盖

```powershell
$env:REPO_ROOT = "D:\apps\foodtestlab"
$env:BACKEND_PATH = "D:\apps\foodtestlab\backend"
$env:FRONTEND_PATH = "D:\apps\foodtestlab"
$env:NGINX_ROOT = "D:\nginx"
$env:DEPLOY_BRANCH = "runon_tencentcloud"
$env:FRONTEND_PORT = "8081"
$env:API_PORT = "3001"
$env:PM2_APP_NAME = "foodtestlab-api"

powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

## 7. 部署后验证

```powershell
# PM2 状态
pm2 list

# API 健康检查（本机）
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing

# 公网检查
Invoke-WebRequest -Uri "http://<你的公网IP>:8081/api/health" -UseBasicParsing
```

## 8. 常见问题

1. 执行策略拦截

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

2. PM2 未找到

```powershell
npm i -g pm2
pm2 -v
```

3. Nginx 未找到

确认 nginx.exe 在 C:\nginx，或设置：

```powershell
$env:NGINX_ROOT = "你的nginx目录"
```

4. 端口冲突

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 8080,8081,3000,3001 }
```

## 9. 快速命令

```powershell
# 一键部署
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1

# 查看服务
pm2 list

# 查看日志
pm2 logs foodtestlab-api

# 重启后端
pm2 restart foodtestlab-api
```
