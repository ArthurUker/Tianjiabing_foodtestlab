# P3 R18：CLOSE-B 三项合同修复限定复审（2026-09-27）

## 裁决

`P3-FIXTURE-CONTRACT-R4`、`P3-PUBLIC-INFRA-TESTS-R2`、`P3-LIFECYCLE-CONTRACT-R7` 在各自定点范围 **PASS_LOCAL_SCOPE**；三窗均明文停止。**现在向原窗口 5 发出 `P3-CLOSE-B-R4` 独占干净实例全量复跑信号。**这不等于全量回归 PASS、部署验收或提交许可。R3 红链与旧证据保留。

| R17 项 | 本轮证据 | 限定结论 |
|---|---|---|
| B-1 | T02B fixture 在 16 链给 School 稳定 id，租户 User 由产品链回放；root DB Jest 11/11 | 定点闭合 |
| B-2 | 两 fixture 用 manager 的 `kind=user` principal；W3 fixture 成功；006 GATE_PASS | 定点闭合，未混用 system 主体 |
| B-3 | live-api 49/49、after-check 11/11；DELETE 200、旧 token 401、墓碑精确一行 | 定点闭合，软删未被抹除 |
| B-4 | session 13/13，墓碑、登录拒绝、禁复活及普通禁用恢复正例 | 定点闭合 |
| B-5 | stats-date 14/14、package-contract 24/24；当前学校身份与显式重授，负例仍 403+隔离 | 定点闭合 |
| B-6 | 五文件离线 29/29；旧 13 文件 SHA/顺序、第 14 条 FK、后接 M1/M2 均有断言 | 定点闭合 |
| 004 真实交错 | 两独立 PG backend PID、竞争会话合法提交后脚本 UPDATE 0 行拒绝；映射主体无孤儿，8/8 | 补证完成 |
| B-7 | R3 runner 在模块顶层读取 W3 env，且未映射 `W3REG_ADMIN_DATABASE_URL` | **仍未修，归窗口 5 R4** |

独立只读复验：F 84/84、P 24/24、L 38/38 的 `HASHES_FINAL` 均 `ALL_MATCH`；冻结 29/29；`test:entry-audit` 24/24、backend 清单 46 文件；P 的五文件 `node --test` 29/29；`git diff --check` rc=0，index 空，HEAD `7343a8a9…`。R7 `R7-004-dual-session.json` 记载不同 PID 11453/11454、竞争者 UPDATE=1、脚本 `MAPPING_RACE_OR_STALE`、映射主体落库 0，证据与自报一致。

## 接力修正

R17 给窗口 5 的旧 prompt 中“T02E fixture 先于 T02B”**作废**。F 的干净实例已经证明实际顺序必须是 **provision up → T02B fixture（最先建学校）→ T02E fixture → root DB Jest → live-api → 学校 B 业务写/report-auth fixture**。T02B 晚于其它学校会触发 `E_SCHOOL_LIST_SCOPE`；live-api 晚于 report-auth fixture 会遇 guest 开关和 after-check 数据合同。窗口 5 新建 runner 与 R4 证据，不改旧 R3 runner/证据。

L 的 S4 fixture 在其独立实例中仍出现 `E_AUDIT_PRINCIPAL_MISSING`，该实例当时没有合入 F 的 B-2 修复；不能把它算成组合链通过。F 的后续独立干净实例已证明两 fixture 与 W3 fixture/006 可联合通过；最终仍由窗口 5 在**同一全量实例**核验全部入口。

R4 的全量判据：每个正式入口 rc=0、0 skip；清单文件数与执行数相等，backend 46 文件含 W3REG PG 用例；readyz=200、租户业务 API 可达、`db:sync --check` 与 006 GATE_PASS。若任一红，登记新原因而不报告 `PASS_LOCAL_REGRESSION`。部署侧两段接线、真实部署、回退和应用角色授权仍另验。

下一棒原文：[P3-NEXT_RELAY_R18_PROMPT.md](../../reviews/global-audit-20260924/phase3/P3-NEXT_RELAY_R18_PROMPT.md)。
