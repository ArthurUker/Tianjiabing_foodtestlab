# 窗口⑤ 任务：运维 + 低严重度收尾（4个bug）

## 环境
- **分支**：`main`（commit `f3b55ae`）
- **只改文件**：`deploy/deploy.sh`
- **切分支**：`git checkout -b fix/window5-ops`

## 上下文

所有 bug 来自第二轮深度审阅（2026-07-27）。本窗口主要修复运维脚本的安全和健壮性。注意：与其它 4 个窗口**零文件重叠**。

---

## Bug 列表

### 🟡 NB-16：deploy.sh 收尾报告明文 echo 密码到 stdout
**位置**：搜索 `echo "  admin / $SEED_ADMIN_PASSWORD"`（约 line 670-673）
**问题**：终端日志/CI 管道日志可捕获明文密码

**修复**：改为不显示明文密码：
```bash
echo "  admin   / (见 backend/.env 中 SEED_ADMIN_PASSWORD)"
echo "  operator/ (见 backend/.env 中 SEED_OPERATOR_PASSWORD)"  
echo "  viewer  / (见 backend/.env 中 SEED_VIEWER_PASSWORD)"
```
如果非要显示，至少检查 `$NODE_ENV` 是否为 `development` 才显示。

---

### 🟡 NB-17：seed/provision 失败仅 warn 不 fail
**位置**：
1. Line 466：`node prisma/seed.js || warn "seed 执行失败..."`
2. Line 480：`node prisma/provision-tenants.js || warn "多租户初始化失败..."`
3. Line 491：`node prisma/syncBootstrapPasswords.js || warn "bootstrap 密码同步失败..."`

**问题**：失败时仍继续后续步骤，最终报告"部署完成"但实际无可用账号或租户 schema

**修复**：将 `provision-tenants.js` 的 `|| warn` 改为 `|| fail`（它创建租户 schema 和 SchoolCustomization，是关键路径）。seed 和 syncBootstrapPasswords 保持 warn 但在收尾报告中显著标记失败。

```bash
# Line 480 改为：
node prisma/provision-tenants.js || fail "多租户初始化失败"
```

---

### 🟢 NB-31：migrate deploy 回退 db push 无 --accept-data-loss 会挂起
**位置**：约 line 447-453
```bash
if npx prisma migrate deploy 2>/dev/null; then
    : # success
else
    warn "prisma migrate deploy 失败，尝试 db push 回退"
    npx prisma db push || fail "prisma db push 也失败"
fi
```

**问题**：若 schema 有破坏性变更（删列/改类型），`db push` 不带 `--accept-data-loss` 会交互式询问 → 非交互式部署挂起

**修复**：在 else 分支中增加 `--accept-data-loss` **但仅当检测到无数据或首部署时使用**：
```bash
else
    warn "prisma migrate deploy 失败，尝试 db push 回退"
    if [ "$FIRST_DEPLOY" = "true" ]; then
        npx prisma db push --accept-data-loss || fail "prisma db push 也失败"
    else
        fail "prisma migrate deploy 失败且非首部署，请手动修复然后再运行部署"
    fi
fi
```
或直接在注释中说明：回退 db push 仅在无破坏性变更时可用，否则应走新 migration 文件。

---

### 🟢 额外：NB-34 HSTS 补充
**位置**：Caddyfile 生成部分（约 line 592-596）
**说明**：已有 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`，缺少 `Strict-Transport-Security`

**修复**：在 header 块中增加：
```caddy
Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
```
仅在 `$DOMAIN` 已配置且有 HTTPS 时才生效（Caddy 自动 HTTPS 已处理）

---

## 自检清单
```bash
bash -n deploy/deploy.sh && echo "deploy.sh syntax OK"
```

## 提交
```bash
git add deploy/deploy.sh
git commit -m "fix(window5): 运维 — 密码不echo/sepd失败改fail/db push回退加固/HSTS"
```
