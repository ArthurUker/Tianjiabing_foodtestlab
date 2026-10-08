# P3 并行轮次 2（CONS-T01 / W0-T02E / W2-T01）— Orchestrator review

日期：2026-09-25。裁决：**CONS-T01 PASS（新基线锁定）；W0-T02E PASS；W2-T01 PASS（闸门段未执行，现已解除闸门 → W2-T01-R1 续作）**。总控只读复核，未代跑、未修改。

## 独立核验记录

- **Git**：HEAD `7343a8a`、branch、index 空，三包一致。
- **输入快照**：CONS 729（12 授权 + 3 T02E 兄弟）、T02E 729（3 授权 + 12 CONS 兄弟）、W2 730（1 授权 + 15 兄弟）——三包均 **PROTECTED 漂移 0、缺失 0**，交叉一致。
- **hash**：CONS 196/196、T02E 37/37、W2 35/35，独立复算全过；冻结 **29/29**。
- **CONS 收口编辑抽查**：`contract.test.mjs:183-187` 裁决溯源注释在、`openApiRoutes.js` oil 分支已改 `${oilVerdictSql()}`、`stats-date` RC-stats-4 `pass_count=1` 溯源在、`main.js` 已走 `getStorageKeys()`。
- **CONS 全量 rc**（rc/ 目录 44 项）：root-full rc=1（恰历史 2 项）、pg-integration 0、isolation 0、29 个 bt-* 逐文件全 0、frozen×2=0、实例 up/down/status=0；root tally 实测 **270/268/2/0**。
- **T02E**：live-api-run.log 实测 **49 ✅ / 0 fail**；两条负例 rc=1；after-check 10 项；实例 down 三条件。
- **W2**：空库回放 bug-exists（E42703 `visible_menu_items` @ unify）与补丁后 rc=0 对照日志在；db:sync 三态（2/0/1）在；迁移文件 `20260726100000_add_customization_columns_if_missing` 已插入链中（baseline 未改、幂等形式）；**`deploy.sh`/`README` 实测未编辑**（闸门 14 次轮询 NOT_PRESENT，`REGRESSION_DONE` 至今不存在——编排缺口：CONS 包未明文要求写标记，本总控责任，后续包内显式化）。

## 总控裁决

1. **新基线锁定**：root Jest **270/268/2/0**（历史 authSession 两项不变）；backend node:test **310/310/0/0**（29 文件逐入口；两段式顺序=过渡 runner 契约）；integration 23/23；isolation 68/68。差值归因：backend 251→310 = +23 W3 +23 W4 +13 W5；root 257→270 = +13（w5OutputEncoding 9 + 更新后的 storage/409 套件）。
2. **DEFECT-1 处置 → 选项①**：恢复引擎在 schema 切换后**重放租户授权**（语义正确的根因修复——恢复必须让目标 schema 的访问授权与恢复前一致，生产恢复同样受益；②③为测试侧创可贴，不治本）。过渡态：两段式顺序 + fixture 链顺序契约（t02b→root→integration→t02c→w3→backend）已文档化。**单实例单次 `test:backend` 全绿**的证明留待 W3-R1 修复后的回归轮。
3. **W2 闸门解除**：CONS 回归已完成（事实条件达成），`REGRESSION_DONE` 标记缺口为编排责任；deploy.sh 段由 **W2-T01-R1** 续作（沙盒与函数契约已就绪）。
4. **W3 写屏障 server.js 挂载**：并入 **W1** 包（server.js 本波即 W1 修改面）。
5. **W2-T02（AUTO_SYNC 默认值/启动自愈降级）**：server.js/tenantSync 禁改约束解除后（W1 之后）执行。
6. T02E 三项可挑战点复核通过：super-admin/login 是生产专用路由（旧 public 路径已被 400/401 双负例固化）；`AUTO_SYNC_TENANTS=false` 仅 harness spawn env（生产开关非改码）；public.AuditLog 保留登录审计属生产语义。

## 下一波（三轮并行，基线已干净）

- **P3-W1-T01**（RC-02 会话模型一次重构，AUD-010/012/014/015/016）：独占 auth 文件面（`backend/middleware/authMiddleware.js`、`backend/modules/UserManager.js`、`backend/routes/{userRoutes,schoolRoutes}.js`、`backend/server.js`）；其余窗口文件对 W1 为 PARALLEL_OTHER。
- **P3-W3-R1**（DEFECT-1 根修）：只动 `restoreService.js` + w3 套件；**禁跑全套件**（其 backend 全量会 import W1 编辑中的 auth 面）——全量复证留 W1 后回归轮。
- **P3-W2-T01-R1**（闸门后 deploy.sh 段）：小范围续作；deploy-jwt-roundtrip 定点回归。
