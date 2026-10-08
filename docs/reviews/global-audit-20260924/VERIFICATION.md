# 审计验证记录

基线 `f08e72e`，执行环境 Node.js 24.15.0、npm 11.12.1、PostgreSQL 18.4。本轮没有修改应用实现。依赖用锁文件安装；Cypress 安装脚本未运行。`npm run build` 改写的源 CSS 已还原，dist/node_modules 等生成目录由原有 ignore 规则排除。

## 环境隔离

创建独立 PostgreSQL cluster，监听 `127.0.0.1:55487`，目录 `/tmp/foodlab-audit-pg.iUoDZW/data`。所有数据库测试显式覆盖连接串，仅连接该临时实例：

- `foodlab_review_test`：空库 migration 验证，保留失败状态供检查。
- `foodlab_runtime_test`：先通过 Prisma db push 创建 public，再以 `?schema=school_reviewtest` 创建专用租户；供测试套件使用。
- 角色触发器测试使用专门创建的 `school_reviewtest` / `review-role-user`，不使用默认 `school_tjb` / `test`。

审计结束后临时 PostgreSQL 已停止。没有读取并采用仓库业务 `.env` 的数据库连接，没有运行实际部署或恢复。

## 实际执行及结果

| 执行内容 | 结果 |
|---|---|
| 根目录、backend 分别 `npm ci --ignore-scripts --no-audit --no-fund` | 成功；锁文件未变 |
| backend `npx prisma generate` | 成功 |
| 空库 `DATABASE_URL=…/foodlab_review_test npx prisma migrate deploy` | 失败，P3018 / 42703，见下方摘要 |
| 隔离 runtime 库 `npx prisma db push --skip-generate`，public 与 school_reviewtest 各一次 | 成功，仅用于准备验证夹具；不能代替 migration 修复 |
| `DATABASE_URL=…/foodlab_runtime_test npm test -- --runInBand` | 26/27 suites 通过；249/251 tests 通过 |
| `REVIEW_TEST_DATABASE_URL=…/foodlab_runtime_test node --test --test-concurrency=1 backend/tests/**/*.test.mjs` | 178/178 通过，0 skip |
| `DATABASE_URL=…/foodlab_runtime_test TEST_SCHEMA=school_reviewtest TEST_ROLE_USER=review-role-user npm run test:integration -- --runInBand` | 2/2 suites、13/13 tests 通过 |
| `node docs/reviews/global-audit-20260924/probes.mjs` | 15 个缺陷行为断言通过 |
| `npm run build` | 成功，但构建顺序缺陷见 AUD-042 |
| `npm run lint`（build 后） | 214 errors，0 warnings；含生成/第三方代码与规则误报 |

上表 `…` 是描述性省略，不是可直接复制的连接串。重跑数据库测试应重新创建独立临时 cluster 和新测试库，显式绑定三个环境变量，不能使用业务 DATABASE_URL。旧测试的隔离缺口本身是 AUD-039。后端 mjs 测试已有更严格的隔离门禁，此优点不应被旧套件的问题掩盖。

初始未准备数据库时根 Jest 7 项失败；配置独立数据库后仅剩以下 2 项。后端 node:test 初次缺少租户 schema、角色测试初次缺少专用触发器所导致的失败，在补全夹具后全部消失，未将它们重复计入问题清单。

### 仍失败的根 Jest 断言

1. `tests/authSession.test.js:259` 期望失败次数 5 即锁定；当前非 production 默认阈值为 1000，测试未设置阈值。
2. `tests/authSession.test.js:294` 期望错误文案“用户不存在或密码错误”；实际为“密码错误”。

这些是测试/实现契约未同步的证据，不能从中推断生产锁定阈值也是 1000。生产分支默认阈值仍为 5。

### 空库迁移失败摘要

```text
10 migrations found in prisma/migrations
Applying migration 20260726000000_baseline
Applying migration 20260729000000_add_must_change_password
Applying migration 20260814000000_remove_backup_model
Applying migration 20260814020000_unify_school_customization_text
Error: P3018
Database error code: 42703
ERROR: column "visible_menu_items" does not exist
```

### 令牌时间边界

在临时 PostgreSQL 执行纯 SELECT：

```sql
SELECT
  to_timestamp(100.1) >= to_timestamp(100 + 1) AS current_check,
  to_timestamp(100.1) >= to_timestamp(100) AS issued_before_revocation;
```

结果分别为 `false`、`true`。这验证了 AUD-015 的比较边界；没有因此声称已经进行完整生产令牌攻击。

## 可独立重跑的最小复现

在根目录与 backend 安装锁定依赖，并完成 Prisma 客户端生成后：

```sh
node docs/reviews/global-audit-20260924/probes.mjs
```

此脚本使用假数据库、本地 supertest、内存 JSDOM；不需要 PostgreSQL，不写入真实学校数据，不向外发送请求，不执行 XSS 载荷，也不执行 DROP SCHEMA。正常结束显式退出，以关闭被导入前端模块的定时器。它调用仓库真实模块而不是重新实现缺陷逻辑；HTTP 测试的认证/数据库依赖是受控替身，因此覆盖边界不等同于完整浏览器端到端测试。

| Probe | 直接观测到的行为 |
|---|---|
| AUD-001 | 切学校后可读取另一校的缓存和待上传任务 |
| AUD-002 | 已认证 B 校 guest 获得 A 校缓存的未脱敏写响应 |
| AUD-003 | 检测字段被渲染为带 onerror 属性的 img 节点 |
| AUD-004 | 恢复暂存名与另一合法租户名相等 |
| AUD-012 | 没有吊销能力的依赖仍可完成 logout 成功响应 |
| AUD-013 | 跨主体 sessionId 被 upsert 并恢复 active |
| AUD-014 | DB 回查失败请求依次得到 200、200、503 |
| AUD-018 | case_id 路径计算逃出指定证据根目录 |
| AUD-021 | 创建应答后临时编辑丢失；临时删除仍留下缓存行 |
| AUD-022 | 409 处理仅更新 version，旧内容重新入队 |
| AUD-023 | normalizeWriteJson 接受 2026-02-30 |
| AUD-024 | 更新构造函数在缺省 status 时写 completed |
| AUD-031 | 字段选项接受自身作为父节点 |
| AUD-048 | schema 替换改写 COPY 行内 JSON 字符串 |
| AUD-049 | 同时间戳的第 201 条安全事件不被后续批次读取 |

结构化观测结果见 [probe-results.json](probe-results.json)。这些断言成功表示缺陷仍存在；修复后应将其改写为安全行为断言，而非继续要求缺陷表现通过。

## 未执行的验证

未运行完整 Cypress/真实浏览器操作、实际相机与识别算法准确率评测、云 KMS、线上反向代理、真实邮件/告警 webhook、破坏性恢复或长时间负载测试。未执行外部依赖 CVE 在线检索。相应风险在主清单中保留条件和边界。
