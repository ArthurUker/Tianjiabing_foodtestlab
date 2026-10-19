# 胶体金照片录入接入说明

实现日期：2026-10-19。交付范围为当前仓库代码、本地隔离验证及部署准备；未连接、迁移或发布生产环境。

## 固定识别方案

唯一识别核心：`ArthurUker/colloidal-gold-reader-lab` 提交
`a0e9d274f5df2bc1ec85f4b6df04f4f81b4c98da`，算法版本
`project-marker-quality-20261018-v5`。`frontend/vendor/colloidal/core.json`
是从该提交生成的版本化发布包，含八个必要 Python 模块及原许可证、逐文件 SHA256。
不含实验台页面、SQLite、真实照片、七项对照适配器、上游模型或权重。

原仓库继续作为算法源码来源。不要直接编辑发布包，也不要修改阈值、定位规则或 C/T 数学后仍声称沿用原版本。
重新生成发布包：

```sh
node scripts/prepare-colloidal-reader.mjs --source /path/to/colloidal-gold-reader-lab --core-only
```

本次未修改识别源仓库、原实验库、模型或历史结果。

## 浏览器运行与依赖

计算在独立 Web Worker 中执行，前端按所选项目调用同一个 v5 核心。Node 不执行图像识别，不启动七方案队列。
Pyodide 0.28.3 及 NumPy、SciPy、Pillow、OpenCV 的 WASM 发布物由
`frontend/vendor/colloidal/runtime-lock.json` 固定 SHA256。
JPEG 解码使用固定 `@jsquash/jpeg@1.6.0` 解码部分（Apache-2.0），不使用其编码器；相关许可证随运行时提供。
运行时均由本站提供，用户浏览器不依赖第三方 CDN。部署准备阶段才从固定地址下载，既有正确文件会复用。

```sh
npm run prepare:colloidal
npm run build:dev
```

`build`、`build:dev`、`build:prod` 和部署脚本均已包含运行时准备。运行时约 41 MiB，首次下载成本需要在真实手机/网络上验证。
`frontend/vendor/colloidal/runtime/` 不入 Git；发布前必须准备，不能仅复制 JS 文件而遗漏 WASM/wheel。

统一 JPEG 解码的原因：原生 Pillow/libjpeg-turbo 与 Pyodide/libjpeg9 在带 EXIF JPEG 样例上产生不同像素；不同浏览器原生 Canvas 解码也存在差异。
隔离对照确认固定 WASM JPEG 解码器在 Chrome/WebKit 中对该样例的解码 RGB 与原生环境逐值相同。
这仅是本批回归证据，不宣称所有 JPEG、颜色配置或实体照片均已完成等价性验证。
PNG/WebP 通过 Python I/O 适配层解码、EXIF 转正后传给原核心。HEIC 可以留存原文件，但当前解码失败时明确提示转换格式或使用手工录入，不承诺 HEIC 识别支持。

所有定位图、窗口图及标线图仅产生于 Worker 内存中的临时目录，调用结束即删除；不会返回到业务后端。
浏览器一次只运行一个照片任务；单张原文件上限 15 MiB、解码像素上限 4000 万；超时保留明确状态。

## 页面和业务规则

- 农残、肉蛋现有点位增加“手工录入 / 拍照上传识别”，手工入口继续使用原同步链路。
- 支持 v5 的七种单检及瘦肉精三联。通用试纸、二氧化硫及三个瘦肉精单检选项不冒充已有三联配置。
- 肉蛋模块增加三联选项，学校现有选项保持；不批量改写学校数据库中的定制配置。
- 现场计时为操作者辅助记录；手动输入为操作者报告。未知时间保留空值，上传/完成时间不代替拍摄时间。
- 300–480 秒内，C 有效时 T<C 阳性→不合格，T>=C 阴性→合格；C 缺失、超时及各类识别失败不产生自动合格性结果。
- 时间未知仅显示图像候选，候选不带“合格/不合格”结论。用户可重拍或主动选择手工方式。
- 自动成功后正常保存，不要求逐张人工复核；不要求填写参考答案，不自动训练客户结果。
- 三联逐通道处理。任一通道不具备有效最终结果时，自动提交拒绝；用户可选择手工逐项录入。
- 表单按明确的检测点位属性收集数据，不会将照片组件内部布局当作额外检测点位。

## 数据和来源

`ColloidalEntry` 对应一次实体卡检测；`ColloidalAttempt` 对应一次上传/识别尝试。
多次重拍归同一 entry，失败不覆盖。首次登记尝试后再上传原照片，即使没有生成正式检测记录，也保留已登记的尝试。

`POST /entries/:id/finalize` 在事务内锁定 entry，将单检一条或三联三条 `TestRecord` 一起创建。
重复提交返回既有记录。三联共享 entry 与原照片，不复制三份文件。

正式记录的 `result_data` 保存：

- `resultSource`：`manual` / `photo_auto`。
- `entryPath`：直接手工、自动成功、失败转手工、照片后选择手工或后续手工修改。
- `photoRecognition`：entry、项目、通道、采用的 attempt、核心提交和算法版本。

直接手工单检也由后端补写明确的 `manual` 来源；历史记录不做批量回填。
通用新增/同步/批量写入不能伪造照片来源。后续手工修改结果保留原识别关联，并将当前结果来源改为手工。
普通列表只显示最终结果；记录详情可展开来源、原照片、失败原因和时间。
详情和原图通过现有学校 schema、身份及记录读取权限访问；不暴露存储路径。

前端只暂存恢复用 entry ID，不把原照片或大数组放入 localStorage。
所有业务网络读写仍经 `StorageService` 的账户/学校作用域访问层；照片与识别回执采用在线方法，普通手工录入保留原离线队列。
账号/学校改变后原组件拒绝继续提交；服务器同样检查 entry 归属。
刷新后可恢复未完成录入，未确认完成的尝试标记 interrupted，不冒充算法错误或生物学无效。

浏览器的 C/T 测量属于客户端产生的数据，后端重算说明书和时效语义、校验项目/通道/版本结构；不宣称仅凭 JSON 校验能证明像素计算未被修改。
没有强制人工对照时，完成率、拒判率、转手工比例可统计；判读准确率需另作独立抽样。

## 原照片管理

业务仅保存客户上传原文件的字节，保持格式、EXIF 等内容；不重新压缩或另存 PNG。
数据库只保存索引、SHA256、格式、文件大小、状态，以及简短结果/失败日志；不保存像素数组、曲线、RGB 诊断大数据或处理后的图片。

环境配置：

| 变量 | 作用 |
|---|---|
| `COLLOIDAL_PHOTO_DIR` | 原照片持久存储目录。未配置时为 `backend/uploads/colloidal-originals`；部署应指向持久数据盘 |
| `COLLOIDAL_PHOTO_RETENTION_DAYS` | 留存天数。默认不设，未确定时不启用滚动删除 |

部署脚本会重组 `.env`，持久自定义配置推荐通过 systemd 服务的 Environment/drop-in 提供，并在重部署后核查；不要只在临时 shell 设置。
`GET /api/colloidal/storage` 仅 manager/admin 可读，提供当前原图数量/占用、近30天新增量、按项目/失败原因分组和记录来源统计。

期限由实际运行占用评估后确定。维护命令默认 dry-run；没有有效天数时拒绝执行。需由运行环境提供 DATABASE_URL（脚本不自动加载其他环境）：

```sh
node backend/scripts/colloidal-photo-maintenance.mjs
# 仅在明确确定留存策略后，由运维显式执行删除：
node backend/scripts/colloidal-photo-maintenance.mjs --apply
```

删除只清理过期原照片；保留哈希、体积、判读/失败日志、正式结果及关联，并显示“照片已按留存策略清理”。
数据库备份不自动等同原图备份；持久目录与备份副本应一并纳入容量、备份和清理策略。

## 数据库及部署

新增迁移 `20261019120000_colloidal_photo_entries`，登记到既有迁移分类注册表，适用于 public 和逐校 schema。
已在本地隔离 PostgreSQL 验证完整迁移链、新租户初始化及两个学校与 public 的结构一致性。
没有对生产执行任何迁移。

正常发布仍需按现有流程执行 public migration、逐租户迁移及 readiness 检查，然后发布前后端。
反向代理模板为原图端点单独允许16MB，Node 对原文件严格限制15MiB，其他API仍保持8MB。
原图采用二进制上传，识别元数据单独限制32KiB。

回退时先切回手工入口/旧前端，保留新增表、原照片及已保存来源信息；不要 DROP 表或删除数据。

## 可复现验证

基础纯函数测试：`npm run test:colloidal`。集成测试必须显式指定隔离库，不读取生产 `.env`；额外验证 PG data_directory 位于本任务 `.cache/colloidal-integration-*` 下。
`npm run test:colloidal:integration` 提供HTTP/数据库检查；`npm run test:colloidal:e2e` 还要求显式提供浏览器模块，避免把缺少浏览器环境当作端到端通过。

以下是本次本机验证命令示例，端口55439为独立测试实例，不是现有业务库：

```sh
COLLOIDAL_TEST_DATABASE_URL='postgresql://colloidal_test@127.0.0.1:55439/colloidal_fixture?schema=public' \
COLLOIDAL_BROWSER_MODULE="file://$PWD/.cache/colloidal-integration-20261019/node_modules/playwright-core/index.mjs" \
node --test backend/tests/colloidal/*.test.mjs
```

浏览器用例须先生成合成测试图片，并提供独立安装的 playwright-core；本机使用 Chrome，其他环境可设置 `COLLOIDAL_CHROMIUM_EXECUTABLE`。

```sh
/path/to/reader-lab/.venv/bin/python scripts/colloidal-native-fixtures.py \
  --source /path/to/reader-lab --output .cache/colloidal-integration-20261019

node scripts/verify-colloidal-browser.mjs \
  --playwright /path/to/playwright-core/index.mjs \
  --fixtures .cache/colloidal-integration-20261019 \
  --chromium '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

# 对已安装的桌面WebKit再执行一次，不等于真实iPhone验收：
node scripts/verify-colloidal-browser.mjs \
  --playwright /path/to/playwright-core/index.mjs \
  --fixtures .cache/colloidal-integration-20261019 --engine webkit
```

本机证据在 `.cache/colloidal-integration-20261019/`（不入库）。包括原生/浏览器 JSON、JPG 解码差异诊断、HTTP/数据库/表单测试输出及390×844详情/三联截图。
原生函数及测试图来自固定源码/合成夹具；不读取原实验照片或实验数据库。

本次执行结果：

- 新增29项检查全部通过，包含16项契约/纯函数测试、实际隔离PG/HTTP及四组浏览器业务流程检查；无跳过项。
- 已有记录归一化、同步路由、餐具判定、结论统计56项回归通过。
- 桌面Chrome与桌面WebKit各11组合成同图回归通过，覆盖七种单检入口、三联、板面、未知时间、结构失败与EXIF方向JPG；该批状态/通道结论一致，C/T绝对差小于0.05。
- 独立PG完整迁移、新学校逐租户迁移及两校/public结构一致性通过。
- 完整后端在独立PG、强制回环监听、无生产dotenv环境下启动，`/api/health`和`/api/readyz`均200；安全消息推送在该夹具中显式关闭。
- 修改的JS/MJS文件ESLint零错误；Prisma schema校验、静态构建、shell语法和Caddy 2.10.2配置适配/验证通过。
- 已目视检查390×844的失败转手工记录详情、原图与来源展示；三联表单完成无横向溢出检查并保留截图。

真实 iPhone Safari、安卓手机的拍照、加载耗时、内存/后台恢复与实体卡准确率仍需现场验收。
v5 原有的通用板、产品身份、结构和几何限制继续适用，本次接入未修改或声称解决这些算法边界。
