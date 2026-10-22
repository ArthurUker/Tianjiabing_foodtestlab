# 独立本地测试免密码入口

2026-10-22：按用户要求，本机与同局域网设备打开测试入口即可进入，不再填写账号密码。

- 本机：`http://127.0.0.1:55539/reader-local-1022/login.html`
- 当前局域网：`https://192.168.60.21:55543/reader-local-1022/login.html`
- 原有登录网址、`/reader-local-1022/` 和 `/reader-local-1022/local-test` 均进入同一自动入口；成功后跳到 `index.html`。
- 局域网相机仍使用既有HTTPS证书；首次设备证书设置在 `http://192.168.60.21:55538/`。IP以实际本机网卡为准。

## 运行方式与边界

实现位于 `scripts/colloidal-local-no-password.cjs`，只由独立测试Node进程显式使用 `--require` 载入。主应用、正式登录页、认证中间件、生产启动及部署脚本均不引用它，无数据库迁移或前端构建变更。

在既有隔离测试启动器中保留原环境和回环监听preload，新增：

```text
COLLOIDAL_LOCAL_STATE_FILE=<本仓库>/.cache/colloidal-local-trial-20261022/private-state.json
node --require <原回环监听preload> --require <本仓库>/scripts/colloidal-local-no-password.cjs <本仓库>/backend/server.js
```

上述为启动参数说明，不能替代既有完整测试环境配置。启动工作目录继续使用隔离的empty-cwd，避免读取正式dotenv。必须同时满足：

1. `NODE_ENV=test`；数据库只能是 `127.0.0.1:55439/colloidal_fixture` 的PostgreSQL。
2. private-state位于当前仓库忽略的`.cache/`内，含既有 `code=reader-local-1022`、`username=localreader`、`password`；文件权限0600，凭据不提交Git、不返回浏览器。
3. `PORT=55539`，`CORS_ORIGIN`明确列出本机及当前LAN HTTPS来源；后端维持回环监听，LAN通过现有私有网卡HTTPS代理访问。

入口在本地进程内调用原 `/api/user/login`，使用现有测试账号取得正常令牌和登录审计；浏览器沿用AuthService存储会话，设备标识透传，后续API仍使用原认证和学校隔离。原始照片、识别日志和检测数据继续保存到原独立测试库及原图目录。每个设备独立取得会话，不共享刷新令牌。

会话入口仅允许POST、白名单Host来源、同源Origin与专用请求头；HTML及响应不缓存。未知来源或缺少Origin拒绝，错误只返回简短状态，不披露账号凭据。正常系统用户、其他学校路径及生产登录保持既有行为。

## CodeBuddy交接

**本项仅本地便利功能，不在服务器部署时启用。** 不把该preload加入systemd、Caddy或正式环境变量；无需修改生产认证、数据库或Python算法。拉取本提交不自动启用免密码。停止本地免密码时，重启测试Node并去掉这个preload及其状态文件环境变量即可；原业务数据、照片和日志继续保留。

本机验证：新Chrome会话分别通过本机HTTP和LAN HTTPS进入index，账号为既有localreader，390px和桌面视口均无pageerror；未向浏览器提供密码。正常health通过，其他学校入口不被接管，跨来源和缺少Origin的会话请求403，生产模式加载preload直接拒绝。浏览器证书测试使用ignoreHTTPSErrors，不代表已替真实手机安装或信任证书。验证截图和摘要只存于 `.cache/colloidal-local-trial-20261022/no-password-*`。
