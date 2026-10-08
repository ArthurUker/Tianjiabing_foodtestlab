# P3-CLOSE-B-R4 全量回归限定复审（R19，2026-09-28）

## 裁决

**测试链 `PASS_LOCAL_REGRESSION` 成立；证据保密性 `REWORK`，暂不提升为最终本地交付签收。** 真实发布、回退与生产授权仍未验收。

R4 `REGRESSION_RESULTS.json` 记录 21 个执行步骤全部 rc=0，另有实例 down 的独立记录；root DB 11/11、unit 286/286、integration 30/30、isolation 68/68、live-api 49/49 + after-check 11/11、report-auth 20/20、session 13/13、单次 backend 460/460 且 0 skip。`logs/S12-test-backend-full.log` 末尾原始计数与报告一致；终态 `db:sync --check`、006 `GATE_PASS`、readyz/租户 API 200 均在包内。`hash-final.mjs --verify-only` 独立复验 85/85 证据、5/5 faces、6/6 untouched，`ALL_MATCH`。R3 红链与旧 runner 保留。004 两会话沿用 L 包证据，本轮没有重跑。

## 必须修正的证据问题

`P3-CLOSE-B-R4/logs/w3-env-map.json` 保存了**完整管理数据库 URL（含密码）与备份主密钥明文**，且在 `env`、`w3Env`、`w3regEnv` 多处重复。R4 `run-regression.mjs` 的 S12 分支直接把 `loadW3Env()` 的完整结果 `JSON.stringify` 写入该文件。报告中的“凭据不进日志”与事实不符。独立扫描本包文件，两个明文值均仅命中这一份 JSON；实例已销毁不等于可以把该证据提交或分发。不得在复审记录或新日志重复明文。

**修复要求**：runner 仅写键名、布尔检查与经脱敏的 URL 归属信息，不写口令/主密钥；立即清除这份证据的明文值，扫描整个本包有无同值副本；以新勘误记载旧文件 hash、脱敏方式与新 hash，重建 HASHES_FINAL 并双复验。若密钥/数据库凭据曾用于非销毁的共享环境，还需轮换；本包称为临时实例，仍须由执行者核实其作用域。历史红日志被后续同名文件覆盖也要在勘误维持明确局限，不补造原始日志。

## 剩余工程事项

1. **B-7b 测试 helper 合同**：`backend/tests/harness-check/_prepare-migrated-instance.mjs` 的 `ensureTenantChain()` 用窄 env 启动子进程，没有传 `SEED_ADMIN_PASSWORD`。R4 通过 S12a 提前用产品路径建 W3REG 学校获得绿链，证明当前编排可用，但其它顺序/CI 仍会因缺口红。由 helper 归属面透传必要口令（不得落日志）或让 W3REG 用例清理自建学校；之后至少复跑受影响 suite 与最终单实例回归。不要以 `ALLOW_INSECURE_TENANT_PASSWORD` 放行。
2. **发布接线与验收**：现行 `deploy/deploy.sh` 仍在 migrate/006 门禁前 `prisma generate`；`backend/scripts/b-release-two-phase.sh` 仅有函数级沙盒。需把 A-client B1、迁移/逐租户回放、`--check`+006、B-client B2 激活、失败停机与 A-client 回退编排落到真实发布流程并演练。
3. **部署授权与发布**：测试/恢复证据表明应用角色对 public/租户/`revoked_tokens` 的授权靠测试准备补齐。须做部署侧授权合同、真实环境预检、一次受控发布与回退演练、上线后 readyz/租户 API/台账复核；当前未 commit/stage/push、未真实部署。

按原五窗口的**本地实现与全量回归**看，已完成；按**可发布交付**看，上述工作仍未完成，不能给出有依据的单一百分比。下一棒以证据脱敏 + B-7b helper 为先，再做发布接线/验收。
