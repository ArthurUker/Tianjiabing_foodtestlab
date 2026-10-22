# 胶体金照片录入接入说明

实现日期：2026-10-19。交付范围为当前仓库代码、本地隔离验证及部署准备；未连接、迁移或发布生产环境。

服务器部署接续请阅读：[CodeBuddy部署交接与提示词](COLLOIDAL_CODEBUDDY_HANDOFF.md)。

2026-10-22新增 [5/6/7分钟三次自动相机采样](COLLOIDAL_TIMED_SAMPLING.md)：显式加样确认、三次原图、实际时距和至少两次有效一致规则；该流程不再使用单张旧入口的within_window假定。

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

## 运行环境（2026-10-20 起：服务端识别）

识别不再在浏览器执行。Node 后端把原图路径投递给常驻 Python 进程 `backend/recognizer/worker.py`，
进程内加载固定 v5 核心与原生 NumPy / SciPy / Pillow / OpenCV，返回与浏览器版结构一致的识别回执。
浏览器只负责上传原图、调用 `POST /api/colloidal/attempts/:id/recognize` 并展示结果。

- 安装/修复运行时：`sudo bash scripts/install-colloidal-recognizer.sh`（固定版本 manylinux wheel，安装到数据盘，不进 Git）
- 运行目录：默认 `/mnt/datadisk0/foodsentinel/recognizer`，可用 `COLLOIDAL_RECOGNIZER_HOME` 覆盖
- 队列：Node 内存 FIFO，并发 1，上限 50，单张超时 90 秒，失败重试 1 次；状态见 `GET /api/colloidal/recognition`
- 进程不监听端口、不连数据库；崩溃后由下一次识别或服务启动自动拉起
- 已移除的浏览器方案：`frontend/js/colloidal/reader.worker.js`、`frontend/vendor/colloidal/runtime/`（约 41 MiB）、
  构建链里的 `prepare:colloidal`。`frontend/vendor/colloidal/core.json` 仍是算法发布包，服务端安装脚本据此展开。
- 解码：原生 Pillow/libjpeg-turbo 与历史隔离对照一致；HEIC 仍只保留原文件，不承诺识别
- 限制：单张原文件 15 MiB、解码像素上限 4000 万；定位图/窗口图只写临时目录并在返回前删除


### 定位板几何判据（核心补丁 geom1，2026-10-21）

原始 v5 核心用固定阈值验收单应：RANSAC 内点阈值 `0.3mm`、要求 `≥75%` 内点、全点残差 `≤0.4mm`。
实测（含手机 3024×4032 原图）该判据等价于“每个角点误差 ≤1–2 像素、纸面绝对平整”，
实拍打印纸（轻微起拱、斜拍、广角畸变）必然被判为“透视不可靠”，定位板模式从未成功。

补丁只改几何验收，不改窗口定位与判读：

- RANSAC 阈值：`max(0.8mm, 2px)`（按检测到的标记像素密度换算）
- 残差：只统计内点，门限 `max(0.8mm, 3px)`
- 内点比例：`60%`（下限 12 点），允许缺 1 个角标（≥3 个即可解单应）
- 回执与 `attempt.result` 增加 `core_patch: "geom1"`，`core.json` 增加 `patch` 字段

**分辨率下限**：窗口定位仍需要真实像素。卡位在照片中至少约 **150 px 宽**（≈5 px/mm），
即板要占画面 1/3 以上；1920×1080 摄像头翻拍屏幕/纸张的定位板照片通常不满足，会停在
“未取得可靠窗口”，请改用手机原图并对准（这不是几何判据的问题）。

## 页面和业务规则

- 农残、肉蛋现有点位复用原“检测结果”下拉：单检为 `合格 / 不合格 / 上传照片识别 / 拍照识别`；手工入口与原同步链路保持不变。
- 支持 v5 的七种单检及瘦肉精三联。通用试纸、二氧化硫及三个瘦肉精单检选项不冒充已有三联配置。
- 肉蛋模块增加三联选项，学校现有选项保持；不批量改写学校数据库中的定制配置。
- 现场确认拍照处于说明书判读时限内，不再采集/推算加样时距（尝试记 `time_source=within_window`，服务端按判读时限内处理）。
- C 有效时 T<C 阳性→不合格，T>=C 阴性→合格；C 缺失及各类识别失败不产生自动合格性结果。
- 自动成功后正常保存，不要求逐张人工复核；不要求填写参考答案，不自动训练客户结果。
- 三联整块隐藏“检测结果”字段，通道区内直接提供 3 个通道下拉与 `拍照识别` / `上传照片识别` 按钮；一张照片识别后自动填满三个通道，也可手工逐项录入。
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

当前C/T由服务端固定核心计算；定时采样成功回执不接受客户端伪造。客户端报告加样确认和抓帧时间，服务端校验时点/通道/版本并重算规则；不宣称能独立证明真实加样时刻或硬件曝光时刻。
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

回退时优先保留本版迁移链兼容的后端，切回手工入口/已验证旧前端，保留新增表、原照片及已保存来源信息；不要 DROP 表或删除数据。
旧后端可能因新增表或迁移证明与其链不一致而被readiness阻断；未经隔离验证，不能把“切旧提交”视为可用回退。详见服务器交接文档。

## 可复现验证

- 纯函数/契约：`npm run test:colloidal`（含时间口径、上下文校验、核心发布包哈希、迁移分类）
- 服务端识别冒烟：

```sh
echo '{"op":"ping"}' | COLLOIDAL_RECOGNIZER_HOME=/mnt/datadisk0/foodsentinel/recognizer \
  python3 backend/recognizer/worker.py
# 真实图片（只读原图，不写库）：
printf '{"id":"t1","path":"/path/to/photo.jpg","projectId":"enrofloxacin","mode":"auto"}\n' | \
  COLLOIDAL_RECOGNIZER_HOME=/mnt/datadisk0/foodsentinel/recognizer python3 backend/recognizer/worker.py
```

- 集成测试（必须显式指定隔离库，不读取生产 `.env`）：`npm run test:colloidal:integration`
- 浏览器端识别用例已随浏览器方案退役；`scripts/verify-colloidal-browser.mjs` 与 `scripts/prepare-colloidal-reader.mjs` 仅作历史追溯/核心打包，不再参与构建。
- 生产验收记录保存在服务器 `/mnt/datadisk0/deploy-backups/<日期>/evidence/`（不入库）。

### 历史记录（浏览器方案时期，2026-10-19）

浏览器方案曾在隔离 PG + Chrome/WebKit 上通过 29 项检查（16 项契约/纯函数、HTTP/DB、4 组浏览器流程），
但冷启动约 50–70 秒，现场体验不可接受；2026-10-20 改为服务端识别后上述浏览器流程不再适用。
保留该记录仅用于说明算法侧 v5 回归曾覆盖七种单检、三联、结构失败与 EXIF 方向等场景。


真实 iPhone Safari、安卓手机的拍照、加载耗时、内存/后台恢复与实体卡准确率仍需现场验收。
v5 原有的通用板、产品身份、结构和几何限制继续适用，本次接入未修改或声称解决这些算法边界。
