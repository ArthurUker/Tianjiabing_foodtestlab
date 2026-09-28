# JWT 密钥配置与门禁（AUD-044 / RC-10）

本文档说明 access/refresh 密钥的**生成、注入、校验与常见拒绝原因**。对应修复任务 P3-W0-T01。

## 1. 规则（单一事实源）

校验规则集中在 `backend/lib/jwtSecretConfig.js`，被以下入口共用（不存在第二套黑名单）：

| 入口 | 触发时机 |
|---|---|
| `backend/server.js` | 进程启动、监听/数据库/后台工作之前；`npm start`、`npm run dev`、直接 `node backend/server.js`、systemd `ExecStart` 最终都到这里 |
| `backend/scripts/validate-jwt-secrets.mjs` | 部署脚本 `deploy/deploy.sh` 在写 `backend/.env` 与重启服务之前调用（`deploy/lib/jwt-config.sh`） |

**所有 NODE_ENV 一致生效**，没有 test/dev/skip 绕过开关。

校验通过时**原样保留密钥字节**（不 trim、不解码、不改编码），既有法定强密钥的令牌语义不变。

### 拒绝条件

- 缺失、空字符串、纯空白
- 含控制字符（`\x00-\x1F`、`\x7F`，如换行/制表符）
- 首尾带空格（`.env` 与 systemd `EnvironmentFile` 无法无损表示，会被拒绝而不是悄悄 trim）
- 文档占位形态（`<...>`）
- 单一字符重复串（如 `aaaa...`）
- 少于 **32 UTF-8 字节**（多字节字符按 UTF-8 字节计）
- 命中公开弱值/示例/占位名单，例如：
  - `.env.example` 历史公开值（`please-run-openssl-...`）
  - `your-super-secret-jwt-key-change-this-in-production`、`your-secret-key-change-in-production`
  - `local-dev-jwt-secret`、`food-lab-secret-key`、`please_change_this_secret`

名单匹配使用 trim 后值：**"占位值 + 空白"同样被拒绝**。不做子串匹配（避免误伤随机值），不强制某种编码（hex/base64/任意 UTF-8 均可用，只要满足上述条件）。

## 2. 生成与注入

```bash
# 生成（任选其一；两者都是密码学安全随机）
openssl rand -hex 32      # 64 个 hex 字符
openssl rand -base64 48   # 64 个 base64 字符

# 方式 A：deploy 自动生成（适配文件留空 JWT_SECRET，首次部署时生成并写入 backend/.env，chmod 600）
# 方式 B：显式注入（推荐流程：先从受控环境提供值，再运行部署）
#   1) 在受控终端 / 密钥管理器中把值导出为**当前环境变量**（示例为随机生成；生产请从密钥库取）
export JWT_SECRET="$(openssl rand -hex 32)"
#   2) 再运行部署：sudo -E 会把当前环境传给 root —— 值始终只在环境里，不出现在任何命令行参数中
sudo -E bash deploy/deploy.sh deploy.<系统名>.conf
#   ⚠️ 不要使用 `sudo JWT_SECRET=xxx bash deploy.sh ...` 这类写法：赋值会出现在可见的 argv / 进程列表里。
```

**部署表示限制（写回 .env 时）**：deploy 以未加引号的 `KEY=value` 行写回，因此注入值若包含
`#`、引号、反斜线、反引号或空白，会在**写回前**被拒绝（原因码 `DEPLOY_REPRESENTATION`），
而不是被静默截断/去引号；安全生成的 hex/base64 与常见合法值不受影响。
直接进程环境（如 systemd `Environment=`、容器 env、手工 export）**不受**该限制，只按强度规则校验。

## 2.1 部署分发要求（首次部署）

`deploy.sh` 启动时会在**任何部署副作用之前**检查 JWT 共享库：存在、可读、`source` 成功、必需函数齐全；
任一不满足即以固定原因非零退出（不会继续安装/动系统服务/连库/clone）。

因此分发包必须保持相对路径（详见 `deploy/README.md`「最小分发清单」）：

```
deploy.sh              # 主脚本
lib/jwt-config.sh      # JWT 共享库（漏传即启动即拒）
deploy.<系统>.conf     # 适配文件（不含真实密钥）
```

后端 JS 模块（`backend/lib/jwtSecretConfig.js`、`backend/lib/jwtSecretResolve.js`、
`backend/scripts/validate-jwt-secrets.mjs`）随 `§4` clone 的代码版本提供，**不需要**放进分发包。

## 3. refresh 密钥语义

- **未设置或恰为空字符串**：运行时按 `<JWT_SECRET>:refresh` 派生（与 `UserManager.getRefreshSecret()` 一致；不新增"两值必须不同"的独立策略）。
- **显式非空**：按同一强度规则校验；**纯空白不是缺省**，会被拒绝。
- deploy 会把显式 refresh 值写回 `backend/.env`，**重部署不丢失、不会意外退回派生值**；完全未配置则保持派生。

## 4. 部署行为

- 校验发生在 `deploy.sh` §5.1：解析（非空环境变量 > 适配文件 > 旧 `.env` **有效值** > 确实缺失才生成）**之后**、写 `backend/.env` 与 `systemctl restart` **之前**。
- 失败立即中止：**不写 `.env`、不重启服务**；既有非空弱值**不会被自动替换/轮换**，需运维更换后重跑。
- 旧 `.env` 的 JWT 两键采用**有效值解析**（dotenv 支持的子集：裸值/配对单双引号/`export` 前缀/键周边空格/行尾注释；不使用 `eval`，不执行文件内容），解析结果等同运行时加载值后再校验。
- **不可读 / 解析歧义 / 重复键**视为错误并中止（退出码 2），**绝不**当成"缺失"而生成新值（避免非预期轮换）；只有"文件不存在"或"确实没有 access 键"才进入生成策略。
- 写回 `.env` 的值经**部署表示检查**（见 §2），随后由共享序列化输出片段（0600 临时文件，值不经 argv/stdout）。

## 5. 常见拒绝与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动/部署报 `KNOWN_WEAK_VALUE` | 使用了公开示例/占位值 | 用 `openssl rand -hex 32` 生成新值替换（已使用过的公开值应视为已泄漏，轮换后旧令牌自然失效） |
| `TOO_SHORT` | 少于 32 字节 | 重新生成足够长度 |
| `WHITESPACE_PADDING` | 值首尾带空格 | 去掉首尾空白（不要用引号包裹来"保留"空格） |
| `CONTROL_CHARACTERS` | 值含换行/制表符 | 重新生成或用单行值 |
| `EMPTY_OR_WHITESPACE` | 空值/纯空白（refresh 显式纯空白也会拒绝） | 填值或删除该行（refresh 删除 = 派生） |
| `DEPLOY_REPRESENTATION` | 注入值含 空格/`#`/引号/反斜线/反引号，无法证明"未加引号写回 .env"无损 | 重新生成（hex/base64），或改用不写回 `.env` 的注入方式（systemd `Environment=`、容器 env） |
| `ENV_FILE_UNREADABLE` | 旧 `.env` 不可读（权限/路径/是目录） | 修复后重跑；脚本**不会**把它当作缺失而生成新值 |
| `DUPLICATE_KEY` / `UNTERMINATED_QUOTE` / `ESCAPE_NOT_SUPPORTED` / `TRAILING_CONTENT` / `UNPARSEABLE_LINE` | 旧 `.env` 中 JWT 键重复或语法超出受支持子集 | 手工整理该文件（保留一行、去掉转义/反引号/多余内容），或删除该键走生成/派生 |

**日志安全**：启动与部署的输出只包含字段名与原因码，不含密钥原值或子串。

## 6. 兼容限制

- 已有**合法**强密钥保持字节不变，无需改格式；本次不执行任何在线轮换。
- 是否已有实例使用过公开示例值，本轮无法从仓库判断；若怀疑使用过，请按密钥轮换流程处理（轮换后需重新登录，旧令牌失效属预期）。
- 仅 `JWT_SECRET` / `JWT_REFRESH_SECRET` 两个键受本门禁管理；其它配置键的历史行为不在本次修复范围。
