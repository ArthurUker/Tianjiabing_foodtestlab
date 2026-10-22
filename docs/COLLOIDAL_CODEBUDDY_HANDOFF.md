# 胶体金照片录入：服务器 CodeBuddy 部署交接

> **2026-10-22 三次定时采样接续**：下一轮部署优先阅读 [5/6/7分钟自动采样与CodeBuddy步骤](COLLOIDAL_TIMED_SAMPLING.md)。沿用现有服务端v5/geom1，新增定时会话迁移；采用规则为三次中至少两次有效且一致。本轮不恢复下文历史浏览器WASM方案。

> **2026-10-20 更新（部署已完成，方案有变更）**
>
> - 功能已上线生产，实际部署 HEAD `a6f7f4e6f83a22f41bd1e154c45ce3d684ba3408`；迁移 `20261019120000_colloidal_photo_entries` 已在 public + 4 所学校应用。
> - **识别改为服务端**：浏览器端识别（Pyodide/WASM Worker）已全部移除，改为 Node 队列 + 常驻 Python 进程
>   `backend/recognizer/worker.py`（原生 NumPy/SciPy/Pillow/OpenCV，不监听端口）。
> - 阅读本文第 4、6、7 节时请以 `docs/COLLOIDAL_READER_INTEGRATION.md` 的“运行环境”一节为准；
>   本文中关于 `prepare:colloidal`、`vendor/colloidal/runtime`、`reader.worker.js` 的描述属于历史方案。
> - 新增运维：`sudo bash scripts/install-colloidal-recognizer.sh` 安装识别运行时；
>   环境变量 `COLLOIDAL_RECOGNIZER_HOME` / `_CONCURRENCY` / `_MAX_QUEUE`；队列状态 `GET /api/colloidal/recognition`。
> - 交互变更：单检复用“检测结果”下拉（合格/不合格/上传照片识别/拍照识别）；三联隐藏该字段，改为 3 个通道下拉 + 两个识别按钮；不再采集加样时距（按判读时限内处理）。

日期：2026-10-19。状态：**已生产部署（2026-10-19），识别方式已于 2026-10-20 改为服务端；真实手机与实体卡准确率仍需现场验收。**

## 1. 本次任务与固定版本

- 仓库：`ArthurUker/Tianjiabing_foodtestlab`；分支：`Product_tencent_CVM`，不是 `main`。
- 功能实现提交：`84d7201b8d60b80e6835a27c435b5116b3043d7a`。
- 本文随其后的交接提交交付；部署时应包含功能提交和本文，记录实际部署的完整 HEAD。
- 开发前基线：`d31e758d9e9cef87b8e56065ec335ff42b989921`。服务器原部署版本未知，必须现场核对；若更旧，应一并列明其间差异，不能只按本功能估算影响。
- 唯一识别算法：`project-marker-quality-20261018-v5`，来自独立识别仓库提交 `a0e9d274f5df2bc1ec85f4b6df04f4f81b4c98da`。

用户已要求将本功能交给服务器上的 CodeBuddy 拉取与部署。按既有发布权限和运维流程执行；本交接不要求再次确认已经确定的产品方案。遇到未知环境、迁移失败或回退不兼容时，保留现场并报告具体阻断，不绕过门禁。

先阅读：

1. 服务器工作区适用的 `AGENTS.md`、`PRODUCTION-ENV-RULES.md`（如存在，后者不在 Git 中）。
2. [项目操作规范](PROJECT_CONVENTIONS.md)。
3. [功能接入说明](COLLOIDAL_READER_INTEGRATION.md)。
4. [现有部署说明](../deploy/README.md)、[迁移失败处置](../deploy/MIGRATION_FAILURE_RUNBOOK.md)。
5. 本文全部步骤，然后核对实际代码和服务器状态。

## 2. 已经确定，不要重新设计的业务边界

- 手工与照片识别并行，正常保存业务记录；不强制客户提供人工参考答案或逐张人工复核。
- 浏览器 Worker 运行固定 v5，Node 管权限、原图、简短回执、事务保存；**不需要新增 Python/Flask 服务、模型权重、GPU 或七方案队列**。
- 七种单检与三联入口均接同一核心。三联是一次实体卡检测关联三条项目记录，共享一份原图。
- 自动失败不产生合格/不合格结果。失败后改手工时，最终记录关联之前的尝试与照片；没有最终记录的失败尝试也保留。
- 普通列表只展示最终结果；有记录读取权限的人可在详情展开照片、来源、失败过程。
- 只存上传原文件；不存裁剪图、定位图、标线图、像素数组或诊断曲线。
- 留存时间尚未确定。**本次不要设置30/90天，不创建自动删除定时任务，不执行清理 `--apply`。**
- 时间未知只保留图像候选；300–480秒内才可按规则生成最终筛查结果。上传时间不能当拍摄时距加样时间。
- 原识别仓库继续维护算法；服务器无需克隆它。校园仓库已有必要的固定源码发布包。

## 3. 部署前只读核对与备份

记录实际值：仓库目录/服务用户、systemd 单元、EnvironmentFile、API回环端口、站点URL、Caddy站点片段、数据盘挂载点、PG版本与目标库（脱敏）、服务器当前HEAD。
不要把本地 macOS 路径、示例服务名或适配文件中的 `main` 当成当前生产值。

```sh
git status --short
git branch --show-current
git remote -v
git log -3 --oneline
git fetch origin Product_tencent_CVM
```

工作区如有本地改动，先识别归属并保留；不要 `reset --hard`、`clean`、自动 stash 或覆盖服务器配置。确认目标分支后，使用可快进方式拉取：

```sh
git merge --ff-only origin/Product_tencent_CVM
git merge-base --is-ancestor 84d7201b8d60b80e6835a27c435b5116b3043d7a HEAD
git rev-parse HEAD
```

上面要求当前分支已是 `Product_tencent_CVM`；分支错误或分叉应先报告，不能强推/重置解决。记录拉取前后版本以及实际新增迁移列表。

在发布窗口前，按现有备份机制备份完整数据库（public及所有学校schema）、服务环境配置、Caddy片段和旧静态发布物；记录备份成功证据及恢复方式。备份、密钥和生产原图不提交Git。审计日志不物理删除。保留旧版本不等于已经证明能回退，见第8节。

## 4. 先准备运行时、构建与原图目录

推荐沿用现有服务器的**增量发布流程**。不要因为此功能重新安装PG、初始化库、重建学校或改已有用户密码。
`deploy/deploy.sh` 已增加运行时准备和原图上传体积规则，但它是完整部署脚本，含环境文件组装、账号同步等既有动作；不可不检查就当作一次轻量重启。若使用该脚本，还须核对它是否保留下面的新增变量。

依赖按两处 lockfile 安装，复用现有 Node/npm 版本（最低要求见 package.json），不升级到 latest。生成Prisma客户端需要backend的开发依赖。

在仓库根目录：

```sh
npm run test:colloidal
npm run build:prod
```

`build:prod` 会自动执行 `prepare:colloidal`，下载固定版本并逐文件校验SHA256，然后生成dist；不需要服务器本机的识别源码目录。
运行时约41MiB，源码仓库不含下载后的二进制。服务器需访问 `runtime-lock.json` 中的固定下载地址；用户浏览器只访问本站。
下载失败或哈希不符时停止，不跳过校验，不改锁文件，不以HTML错误页冒充WASM。受限网络可离线转运同版本已校验的runtime目录，再运行准备命令复验。

确认产物至少包含：

```text
dist/index.html
dist/login.html
dist/css/colloidal.css
dist/js/colloidal/PhotoEntry.js
dist/js/colloidal/reader.worker.js
dist/js/colloidal/browser_entry.py
dist/vendor/colloidal/core.json
dist/vendor/colloidal/runtime/pyodide.mjs
dist/vendor/colloidal/runtime/pyodide.asm.wasm
dist/vendor/colloidal/runtime/jpeg/decode.js
```

原图持久存储新增配置：

| 配置 | 本次执行要求 |
|---|---|
| `COLLOIDAL_PHOTO_DIR` | 设置为现有已挂载数据盘中的独立绝对路径；按现场目录布局确定。不要指向dist、临时目录或公开静态目录。 |
| `COLLOIDAL_PHOTO_RETENTION_DAYS` | 保持未设置/空值；不启用定期删除。 |

确认挂载真实存在、剩余空间和inode充足；目录由实际systemd服务用户可读写，建议根目录0700。不要为查看原图开放Caddy静态访问，原图通过带权限API读取。
默认路径是 `backend/uploads/colloidal-originals`，生产应明确设置持久路径。若服务器已产生照片，改目录前先核对和迁移旧文件，不让历史索引失效。
将变量写入**实际生效的服务环境配置**，保持原JWT、PG、备份密钥及其他变量；不要整文件覆盖。若systemd配置有 `ReadWritePaths` 等沙箱限制，须放行该目录并核对实际写入。

## 5. 数据库升级：public和逐校都必须完成

新增迁移：`20261019120000_colloidal_photo_entries`，两张表 `ColloidalEntry` / `ColloidalAttempt`，五个索引，已登记 `scope=both` 和校验和。
它同时属于public和学校业务schema；仅执行public迁移会导致学校录入不可用。启动服务本身只检查结构，不代替显式迁移。

在备份完成、版本和数据库目标核对无误后，使用与服务一致的受控环境依次执行：

```sh
# 工作目录：仓库/backend；使用backend已安装、锁定版本的Prisma
./node_modules/.bin/prisma generate
./node_modules/.bin/prisma migrate status
./node_modules/.bin/prisma migrate deploy

# 工作目录：仓库根目录
node backend/sync-tenant-schemas.mjs
node backend/sync-tenant-schemas.mjs --check
```

上述是分步操作，**不是忽略退出码的一键脚本**。`migrate status` 因待应用迁移非零时，先核对是否正是预期列表；failed/checksum/baseline异常不得当普通pending跳过。
Prisma默认会读取backend/.env；租户脚本默认读backend/.env，外置环境文件可用 `DB_SYNC_ENV_FILE` 显式指定。数据库环境必须一致，不打印DATABASE_URL或密钥，不对任意env文件直接执行shell `source`。

public成功后再推进全部非删除学校（包含disabled），最后 `--check` 须退出0。保留逐校结果和失败证据。
若服务器原版本落后，本轮也会应用其间其他待执行迁移；先评估完整列表，不能只核对最后一个文件。
遇到P3005/P3009、结构漂移、迁移锁或台账失败，按既有runbook保留现场处理；不自动resolve，不 `db push`，不清台账，不DROP额外对象，不关闭readiness。

## 6. Caddy与服务发布

核对并更新**当前应用自己的**Caddy片段，保留其他站点、学校路径重写、静态缓存及现有安全配置。`deploy/deploy.sh` 中的新增API块是实际模板：

```caddyfile
handle /api/* {
    @colloidalOriginal path_regexp colloidalOriginal ^/api/colloidal/attempts/[0-9A-Fa-f-]{36}/photo$
    @regularApi {
        not path_regexp colloidalOriginal ^/api/colloidal/attempts/[0-9A-Fa-f-]{36}/photo$
    }
    request_body @colloidalOriginal {
        max_size 16MB
    }
    request_body @regularApi {
        max_size 8MB
    }
    # 此端口为示意：保留现场原来的API回环端口
    reverse_proxy 127.0.0.1:3000
}
```

只替换既有API块的请求体规则，不再添加第二个相同handle。Node对原文件另限15MiB，JSON识别回执限32KiB；不要提高所有API的全局上限。
先 `caddy validate --config /etc/caddy/Caddyfile`，通过后按原流程reload；不要重写主配置覆盖别的应用。
构建、数据库、目录和代理检查通过后再发布dist、重启实际systemd服务。后端保持回环监听，不新增公网API端口。

验收 `/api/health` 和 `/api/readyz` **都为200且JSON正确**；health成功不代表学校迁移完成。使用实际学校路径登录，确认原手工流程及新入口，并确认API未被SPA回退成HTML。
检查WASM、mjs、wheel、core.json等请求返回真实文件和合适MIME，避免路径重写或缓存导致假200。原图URL必须经过权限控制，不能直接暴露文件目录。

## 7. 服务器验收与真实设备待办

本地已经完成的证据：新增29项（16项契约+隔离PG/HTTP+4组浏览器业务流程）全通过、56项既有回归通过；Chrome/WebKit各11组合成同图对照通过；public/两校迁移与健康/就绪检查通过。**这些不是生产部署结果，也不是真实手机或实体卡准确率。** 原始本机证据在忽略的.cache目录，不随Git转移。

服务器发布后记录以下结果，优先使用独立测试学校和经授权的测试样本：

| 项目 | 通过标准 |
|---|---|
| 旧手工录入 | 正常保存、查询、同步，带manual来源；现有其他模块不受影响 |
| 单检有效时间自动成功 | 原图和attempt保留，正式结果来源photo_auto，详情可查看 |
| 自动失败转手工 | 不先生成自动合格性记录；手工正式记录关联失败尝试和原图 |
| 时间未知/超时 | 不能自动保存为合格/不合格；未知只显示候选 |
| 三联 | 一次保存恰好三条项目记录，共享entry和原图；重复提交不重复生成 |
| 刷新/多次重拍 | 可恢复未完成entry，尝试历史保留，照片不存localStorage |
| 权限/学校 | 未登录不能访问；只读角色不能写；其他学校不能读取原图或entry；列表简洁、详情按既有记录权限展开 |
| 原图字节与容量 | 上传原文件SHA256/大小一致，只新增原文件；无裁剪/标线图片；manager/admin的 `/api/colloidal/storage` 可统计 |
| 上传大小与代理 | 在独立测试环境用8–15MiB合法原图验证原图端点，其它API保持原限制；超15MiB拒绝 |

独立PG/HTTP测试脚本**禁止连接生产**。它只接受严格限定的回环隔离库和本任务fixture路径；不要为了在服务器跑测试而删除防误连检查。服务器普通验收不需要安装浏览器测试依赖或单独识别源码。

随后安排真实iPhone Safari、安卓主流浏览器、电脑浏览器：首次冷加载/后续加载、相机与相册、EXIF方向、重拍、断网恢复、切后台、耗时和内存表现。记录型号、OS/浏览器、网络、图像格式与大小、所选项目、加样时间来源、结果和失败原因。
运行时首次约41MiB，必须实测移动网络。JPG/PNG/WebP为当前识别入口；HEIC原文件可保留，当前不承诺HEIC识别，失败时提示换格式/手工。
实体卡正确性需独立抽样人工对照，客户日常不强制填参考答案；不能用“算法跑完/照片上传成功”声称识别准确率。

## 8. 回退与交付回报

回退优先保留本版已识别新增迁移的后端，撤下新照片入口或回退前端到已验证的手工流程；保留两张新表、原图、结果和审计记录。
**不能保证直接切旧后端即可恢复：旧版本迁移链/readiness可能把新增表/迁移视为额外对象或不一致而阻断。** 切旧后端前必须在隔离副本验证；若不兼容，使用兼容新链的手工入口修订。不要为回退DROP新表、删除迁移证明或绕过readiness。
恢复数据库属于独立恢复操作，必须评估备份后新数据，不能用覆盖整库代替功能回退。

给用户回报：部署前后完整SHA、实际服务/站点（不含密钥）、备份证据、public与逐校迁移结果、构建/运行时校验结果、原图持久目录与容量、Caddy及health/readyz、各业务验收结果、真实设备已测/未测、失败原因和回退状态。照片留存天数明确写“未设置，自动删除未启用”。

## 9. 可直接复制给CodeBuddy的接续提示词

```text
请接续部署胶体金照片录入功能。仓库ArthurUker/Tianjiabing_foodtestlab，分支Product_tencent_CVM；功能提交84d7201b8d60b80e6835a27c435b5116b3043d7a，另有后续交接文档提交，需一并拉取。
先阅读当前工作区适用的AGENTS.md/PRODUCTION-ENV-RULES.md（若存在）、docs/PROJECT_CONVENTIONS.md、docs/COLLOIDAL_CODEBUDDY_HANDOFF.md、docs/COLLOIDAL_READER_INTEGRATION.md及现有部署/迁移runbook，然后核对实际服务器版本、服务、学校schema、环境文件、数据盘和Caddy配置。
用户已指定由服务器CodeBuddy拉取和部署，请按既有发布流程完成现场核对、备份、固定依赖与运行时构建、public和全部非删除学校迁移、原图持久目录配置、代理规则更新、服务发布和验收，保留每步证据；不要停在给出计划。
只用固定v5浏览器识别核心，不接七个历史方案，不新增Python服务；保留手工入口，自动失败转手工须留痕，三联一次三条记录，只存原始上传图片。照片留存期限未定，本次不设天数、不建自动删除任务。
不要reset/clean覆盖服务器本地改动，不输出密钥，不删除审计或业务证据，不盲目db push/resolve，不关闭readiness。迁移或环境门禁失败保留现场、说明具体阻断，不能伪报上线。旧后端可能不兼容新增迁移，回退按交接文档处理。
部署成功与真实手机/实体卡验收分开报告。最后回报实际完整HEAD、备份和迁移、运行时/静态资源、health/readyz、业务及权限验收、原图存储、留存未启用状态和手机测试待办。
```
