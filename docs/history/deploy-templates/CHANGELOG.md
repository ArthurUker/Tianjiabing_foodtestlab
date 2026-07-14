# deploy.template.ps1 变更记录

本文件记录对 `deploy.template.ps1` 的历次修订，供核查各客户分支脚本版本差异时对照使用。

---

## 格式说明

```
[日期] [修订类型] [说明]
- 影响范围：受影响的脚本节（§号）
- 对照检查：客户分支 deploy.ps1 是否需要同步此修改
```

---

## 变更列表

### 2026-07-08 — 模板首次建立（基于珠海一中分支审计）

**[确认]** `pm2 save` 已在 §7 PM2 启动节正确放置
- 影响范围：§7（`npx pm2 save` 位于 `pm2 start/restart` 成功后）
- 对照检查：客户分支 `deploy.ps1` 中 §7 **必须**包含 `npx pm2 save`，否则服务器重启后 pm2 进程列表丢失

**[新增 TODO]** Windows 开机自启机制（`pm2 startup` 等效方案）尚未实现
- 影响范围：§7，`npx pm2 save` 之后的 TODO 注释块
- 当前状态：服务器重启后需人工执行 `npx pm2 resurrect` 或重新部署
- 推荐方案 A：`npm install -g pm2-windows-startup` + `pm2-windows-startup install`
- 推荐方案 B：使用 nssm/winsw 将 PM2 注册为 Windows 服务（无需登录即可自启）
- 对照检查：所有客户分支均未实现此项，待统一规划后同步

**[新增]** §3 多系统隔离检查扩展为三系统（RDPMS / 田家炳 / 珠海一中）
- 影响范围：§3 端口冲突检查变量 `$allUsedPorts`、`$allUsedPm2Names`
- 对照检查：新增客户时在此列表追加对应端口和 PM2 名称

**[新增]** §10 Nginx 配置内追加新客户 server{} 块的 TODO 模板注释
- 影响范围：§10 `$fullNginxConf` here-string
- 对照检查：每次新增客户后需更新所有客户分支的 Nginx 配置块

---

## 客户分支脚本同步状态

| 客户分支 | 是否包含 pm2 save | Windows 自启 | 最后对照日期 |
|---|:---:|:---:|---|
| `ZhuHaiYiZhong`（珠海一中） | ✅ | ❌ 未实现（TODO） | 2026-07-08 |
| 田家炳（`main` 分支 ecosystem.config.cjs） | N/A（使用配置文件模式）| 未知 | 待检查 |
