# P3-CLOSE-B-R3 全量红链限定复审（R17，2026-09-27）

## 裁决

**入口修复 PASS_LOCAL_SCOPE；全量回归仍 RED，不能报 PASS_LOCAL_REGRESSION。** 旧 G3 漏收录已修，当前 `test:entry-audit` 独立复跑 **24/24、rc=0**，backend 递归清单 46 文件。R3 `HASHES_FINAL` 独立复验 **85/85 证据 + 9/9 源码 + 6/6 未触及，ALL_MATCH**；冻结 29/29、`git diff --check` rc=0、HEAD 不变。执行者保留首个被污染实例并整体重建，未用手工 SQL 拼绿。当前单实例结果：unit 286/286、isolation 68/68、integration 30/30；backend 390 pass / **25 fail**，其他入口亦红；没有全量 PASS。

## 红项归因修正

R3 的六类主因大体成立，但需要三处精确更正及一个独立门禁：

1. **B-3 不是“删除 API 未调用”**。`tests/integration/live-api.mjs` 清理段已调用 `DELETE /api/user/:id`，原始日志记 **200**。生命周期 M1 把该动作改为**软删除**，所以 `t02c-live-api-harness.mjs` 的“租户表只能有两个物理行”断言过时。应验证两个有效契约账号 + 恰当的已删除测试账号墓碑（`deleted_at`、disabled、不可登录/复活），并让脚本显式断言 DELETE 200；不得物理清除墓碑或将所有额外用户宽泛放行。
2. **B-6 实际是 6 个失败断言，跨 5 个测试文件**：`publicInfraChain` 1、`publicInfraFollowup` 2、`w2t02r4/r5/r6` 各 1。除硬编码 14 外，`publicInfraFollowup` 把 public FK migration 认作“当前链尾”，现尾已是 M2。须保留“旧 13 字节一致 + public FK 位于第 14 位 + 其后 M1/M2”历史位置证明，再断言现链 16，不能只把所有 14 替换成 16。
3. **B-2 的推荐修法不能把 system principal 与 `user_id=manager` 拼在同一事件**。那会违反 G3 人类/系统主体归属。受限 DML 探针应绑定该 manager 的真实 `kind=user` principal，或将探针构造为 `user_id IS NULL`、无快照的真实系统事件并绑定 system principal；整组写入仍在回滚事务中，复核 G3/006。
4. **新增 B-7（runner 环境，独立于 B-2）**：`w3r2cross-register-external.pg.integration.test.mjs` 要求 `W3REG_ADMIN_DATABASE_URL`、`BACKUP_DIR`、`BACKUP_MASTER_KEY`；R3 runner 的 S12 仅合并 `w3Env`，其中管理连接键叫 `W3_ADMIN_DATABASE_URL`，且 `w3Env` 在模块顶层读取，可能早于 S6b 生成 env 文件。W3 四项缺环境可由 B-2 级联，**W3REG 一项须单独解决**，不能把 5 项全部归 B-2。新 runner 应在 S6b 成功后重新读取环境，并明确映射 W3REG 管理 URL；缺任何必填项仍 fail-closed。

原 B-1（School.id）、B-4（软删旧断言）、B-5（grant 身份）成立。B-5 的 25 失败分栏按日志是 **12 项**：`package-contract` 管理端 dict 替身 1 项，`stats-date` 真库 grant setup 导致 11 项；其余为 W3/注册环境 5、report-auth fixture 1、session 1、链旧断言 6，共 25。`openapi-http` 已示范正确的 `school_id/school_generation` setup；产品读时 fail-closed 不应放宽。

## 下一棒与边界

开三个不碰共享产品面的限定修复窗，可并行编辑不同文件：fixture/测试清理（B-1/2/3）、生命周期测试合同与双会话补证（B-4/5 + 004 证据）、公共链旧单测（B-6）。每窗独占实例或只做离线定点，不共享测试库；旧 R3 证据原样保留。三窗停止并经复核后，由 CLOSE-B 窗口**新建 R4 证据和 runner**补 B-7、重建干净实例单次全量回归。`deploy.sh` 两段接线、生产授权和真实部署仍 HOLD。
