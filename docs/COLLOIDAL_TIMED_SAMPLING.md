# 胶体金自动检测：5/6/7分钟三次相机采样

日期：2026-10-22。代码基线为远端 `478ac03`（已改为服务端常驻识别，并含geom1几何补丁）。
接续更新：[识别过程日志、旋转／镜像预览与局域网测试](COLLOIDAL_PROCESS_LOG.md)。
本次新增完整采样流程；不恢复浏览器WASM，不改当前光学算法、不引入七个对照方案。
状态：本地实现与隔离验证；本轮服务器部署、真实手机7分钟连续采样、实体卡准确率尚待执行。

## 已确认的流程与采用规则

用户确认：填写信息和相机预览后，点击“已完成加样，开始计时”作为零点；第5、6、7分钟各拍一次；**三次中至少两次有效且结论一致即可采用**。

1. 在果蔬/肉蛋点位填写日期、食堂、检测员、样本品种、检测项目。
2. 点击“开始自动检测（3次采样）”，授权持续网页相机，调整到完整单卡或当前v5定位板。
3. 完成加样后立即点击“已完成加样，开始计时”。此后冻结本次样本信息，不自动推测加样时刻。
4. 前台倒计时，在300、360、420秒抓取三个新的相机帧，各生成一份相机原始JPEG；无需逐张点快门。
5. 每张分别登记、上传原图、调用现有服务端v5识别。拍照调度与上传/识别独立，后端排队不推迟下一次快门。
6. 三次均尝试完成后，由服务端评估：至少两张有效且同结论即可填入自动结果；第三张失败/相反结果保留。
7. 客户点击原表单“保存”。单检仍是一条记录；三联仍是三条记录，共享三张照片和同一entry，不生成九条检测记录。

三联的“一致”是**同两次照片的三个通道结果向量相同**，不把不同照片的通道拼接成一个从未被完整观察到的结果。
采用符合一致组的最后一次有效照片，不能任意选一张或总是用第7分钟那张。
两次有效但互相矛盾、只有一次有效、无效C线、质量失败均不强行生成自动结论，可重测或主动改手工。
采样尚未结束不允许保存；结束/中断会保留真实状态和缺失时点原因。若中断前已取得至少两次有效且一致的结果，仍可按用户确认的2/3规则采用；不足两次则不能自动给出结果。

## 时间、相机与原图边界

当前v5的 `lab/rules.py` 引用了已提供的铅卡说明书 `RS-2026-01A`，窗口300–480秒。
本流程沿用该研发基线；**不能因此宣称每个厂家/项目的说明书都已逐一验证**。实际试用须核对卡片说明书与该窗口是否相符。

- 记录的是浏览器抓取该帧时距人工确认加样的秒数；不是上传/排队/识别完成时间，也不是硬件传感器曝光时间的独立证明。
- 保存 `sampling.startedAt`、服务器接收时间、每张 `captured_at` 和 `elapsed_seconds`；同步比较单调时钟与设备时钟，明显跳变则中断。
- 每个计划时点允许最多15秒调度延迟，属于本次采样工程规则；不是修改说明书的5–8分钟有效窗口。错过该时点记缺失，不集中补拍、不回填计划时间。
- 使用持续 `getUserMedia` 预览；系统文件选择器/手机系统相机不能在网页后台自动连续按快门。
- 在尚需拍摄时切后台、锁屏、离开点位或相机停止则中断。刷新不能恢复连续取样的可信性，恢复入口会结束旧会话并保留缺失时点。
- 三张抓取完立即关闭相机；识别回执可继续等待。定时识别请求最多等待180秒，排队过长/网络失败保留未确认状态，不延后或伪造拍照时间。
- 屏幕唤醒锁在浏览器支持时尝试申请，不把成功保持唤醒当成保证。自动拍摄需要HTTPS/localhost和相机权限；真实iPhone/安卓仍需实测。
- JPEG来自相机当前画面，保持该帧分辨率，不裁剪/标线/合成；它本身就是本次拍照的原文件。既有相册上传仍保留上传字节，不转码。
- 不保存连续视频、中间处理图、像素数组或曲线。每次实体卡测试最多新增三张自动采样原图；三联不复制三份。
- 原照片留存天数继续未设，不新增自动删除任务。照片按策略清理后，历史判读/一致性统计仍保留；新自动保存仍要求采用照片存在。

相关浏览器约束见 [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[页面可见性事件](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event)、[新视频帧回调](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)。

## 数据、服务端校验和报告

新增迁移 `20261022120000_colloidal_timed_sampling`（4条SQL，scope=both）：

- `ColloidalEntry.sampling`：会话、固定计划、人工确认时间、服务端接收时间、状态、结束原因、2/3规则和简短统计。
- `ColloidalAttempt.sample_index`、`captured_at`：1/2/3时点及实际抓帧时间；沿用elapsed_seconds和原图字段。
- `(entry_id,sample_index)` 唯一索引，索引只能1–3；已有单张上传的NULL索引可继续存在。
- 新会话只可建立在无照片尝试的open entry；旧照片不混入新定时批次。重测请新建检测点位。

新增API（均走原认证与租户客户端）：

| API | 用途 |
|---|---|
| `POST /api/colloidal/entries/:id/sampling/start` | 开始计时，body含id、planId=`minutes_5_6_7`、startedAt |
| `POST /api/colloidal/entries/:id/attempts` | 定时照片附带samplingId、sampleIndex、capturedAt、elapsedSeconds、timeSource=`scheduled_camera`、source=`camera` |
| 既有PUT photo / POST recognize | 原图和服务器判读；定时会话不接受客户端伪造成功判读 |
| `POST /api/colloidal/entries/:id/sampling/finish` | state=completed/interrupted；补记缺失时点，事务结束会话，返回三次报告 |
| 既有GET entry / GET record详情 | 返回samplingSummary、三次测量值、计划/实拍时间、失败/分歧和原图索引 |
| 既有POST finalize | 服务端重算2/3规则并校验采用照片，事务/幂等保存1或3条记录 |

列表保持原样。当前检测区显示三次计划/实拍时间、每通道判读和C/T；记录详情展开后可查看三张原图、失败原因、有效数、一致数与是否存在不同结论。
管理接口 `GET /api/colloidal/storage` 新增 `samplingRuns`（实体卡批次）和 `samplingSlots`（各时点尝试/原图/有效识别计数）；与三联正式记录条数区分。
来源 `entryPath=auto_two_of_three_consistent` 或 `manual_after_sampling`；照片与失败均关联后续手工结果。

## 本次验证如何理解

测试命令和最终执行结果见本节末尾的记录。数据库/HTTP验证使用独立回环PG，绝不读取生产dotenv；浏览器测试用Chrome模拟相机和受控时钟，7分钟流程被加速。
其中浏览器业务流程使用可控的服务器识别回执，覆盖调度、网络排队、2/3采用、三联、切后台和错过时点；**它们不证明模拟相机画面的光学识别正确**。

另有独立光学链路回归：将当前core发布包展开到临时目录，用实际 `ColloidalRecognizer → worker.py → server_entry.py → v5/geom1` 识别11组合成夹具，比较原生参考状态、通道、最终规则与C/T（差值<1e-6）。不读取实验照片或实验数据库。

```sh
npm run test:colloidal

# HTTP/浏览器测试只允许显式的本地隔离库和浏览器模块：
COLLOIDAL_TEST_DATABASE_URL='postgresql://colloidal_test@127.0.0.1:55439/colloidal_fixture?schema=public' \
COLLOIDAL_BROWSER_MODULE="file://$PWD/.cache/colloidal-integration-20261019/node_modules/playwright-core/index.mjs" \
node --test backend/tests/colloidal/*.test.mjs

# 仅在已有隔离Python环境及合成夹具时执行；不连接数据库：
node scripts/verify-colloidal-server.mjs --python /absolute/path/to/isolated/python --fixtures /path/to/synthetic-fixtures

npm run build:prod
```

真实运行和算法可行性试验：先在独立测试学校验证实际7分钟链路，保留已知阴性/阳性及弱线样本的三张照片；按项目、卡批次、手机/相机、光照分别统计。
每批记录采样完成率、单张可判读率、2/3可采用率、分歧率、失败原因、人工对照的错判情况和耗时。
研发人员可在独立试验中建立人工参考答案；客户日常录入不新增强制参考答案步骤。
“两张一致”只代表重复判读一致，不能证明结论正确；没有独立参考结果时只能统计完成/拒判/分歧，不能给出准确率。

2026-10-22本机执行记录：

| 检查 | 结果与边界 |
|---|---|
| 胶体金契约/采样规则、真实隔离PG/HTTP、浏览器流程 | 54项全部通过，零跳过；其中11组浏览器流程使用模拟相机/可控回执，定时流程使用受控时钟 |
| 现有记录归一化、同步、餐具判定与统计回归 | 56项通过 |
| 实际常驻Python识别进程与当前core/geom1 | 11组合成同图对照通过，状态/通道/最终规则一致，C/T绝对差<1e-6 |
| 新迁移、逐租户同步、结构一致性 | 隔离PG通过；未操作生产数据库 |
| 完整后端启动 | 隔离PG、回环监听、无生产dotenv，health/readyz均200 |
| 改动JS/MJS的ESLint、静态构建、Prisma校验、文档链接和diff检查 | 通过 |
| 390像素截图 | 已目视检查三次时间、C/T、2/3结果与第三次分歧；无横向溢出 |

本机原始证据在忽略的 `.cache/colloidal-timed-20261022/`；相机流程截图位于 `.cache/colloidal-integration-20261019/timed-majority-20261022.png`。这些测试数据库、模拟照片、依赖和原始日志不随Git交付。

## CodeBuddy服务器接续

1. 先读本文件、`PROJECT_CONVENTIONS.md`、服务器现场规则及现有部署runbook。拉取 `Product_tencent_CVM`，记录部署前后SHA；保留服务器本地配置与改动。
2. 本轮不改core发布包、几何/测量阈值和识别运行时；已在运行的v5/geom1无需因本功能重装。核对服务端识别进程仍可用。
3. 备份，生成Prisma客户端；依次执行public `prisma migrate deploy`、逐校 `node backend/sync-tenant-schemas.mjs`、只读 `--check`。不可修改旧迁移或用db push跳过迁移证明。
4. 构建 `npm run build:prod`，发布前后端并重启实际应用服务；Caddy沿用现有原图限额及HTTPS配置，不新增服务/端口。核对两份新前端模块 `TimedSampling.js`、`sampling.js` 均返回JS，`/api/health`、`/api/readyz`均200。
5. 旧手工、单张上传继续验收；再在真实iPhone/安卓/电脑按上述流程验证5/6/7分钟三次自动快门，以及两次一致、第三失败、第三相反、两次互相矛盾、切后台、相机中断、断网、恢复和三联。
6. 只检查/记录原图容量，不设置留存天数或删除任务。生产测试不得删除审计日志。
7. 回报部署/迁移/设备证据与算法对照结果，区分“链路可用”和“准确率已验证”。失败保留现场，不绕过readiness。回退保持新增数据与迁移证明；旧后端兼容性须验证。

可直接交给CodeBuddy：

```text
请接续部署胶体金5/6/7分钟三次自动相机采样，分支Product_tencent_CVM。
先读docs/COLLOIDAL_TIMED_SAMPLING.md和项目/服务器规则，按文档完成备份、public和逐校新迁移、前后端构建发布、health/readyz及真实设备验收，不要只输出计划。
计时从“已完成加样”点击开始；三次至少两次有效且结论一致即可，三联要求同两张照片的整卡通道向量相同；第三次失败/相反保留，不能混通道或覆盖记录。
沿用当前服务端v5/geom1，不恢复WASM、不重装或修改算法。只存三张相机原始JPEG，保留手工和单张上传；留存时间未定，不启用自动删除。
本地模拟时钟/相机和合成光学回归不是真实手机/实体卡准确率。请记录实际7分钟采样、设备/项目/卡批次、原图、失败和独立参考结果，回报链路与准确率证据的实际完成边界。
```
