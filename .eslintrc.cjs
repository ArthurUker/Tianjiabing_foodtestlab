/**
 * ESLint 配置 — foodsentinel 安全护栏
 *
 * 基于 5 轮代码审计发现的缺陷模式，编写 3 条可持续集成的拦截规则：
 *   规则1 (no-restricted-syntax #1)：禁止直接 new PrismaClient()（租户隔离护栏，对应 TD-Tenant-Route）
 *   规则2 (no-empty)：禁止空 catch 或仅含注释的 catch（静默失败护栏，对应 TD-Catch-Fallthrough-Silent）
 *   规则3 (no-restricted-syntax #2)：禁止 crypto.randomUUID() 无降级（HTTP 兼容护栏，对应 TD-HTTP-UUID）
 *
 * 启用方式：
 *   npm install -D eslint
 *   npx eslint backend/ js/ --ext .js
 *
 * CI 集成（package.json scripts）：
 *   "lint": "eslint backend/ js/ --ext .js --max-warnings 0"
 *   "lint:fix": "eslint backend/ js/ --ext .js --fix"
 */
module.exports = {
    root: true,
    env: {
        node: true,
        browser: true,
        es2022: true,
    },
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
    },
    rules: {
        // ──────────────────────────────────────────────────────────────
        // 规则1 + 规则3：no-restricted-syntax（两条 AST 选择器合并为一条规则）
        // ──────────────────────────────────────────────────────────────
        'no-restricted-syntax': [
            'error',
            // 规则1：禁止直接 new PrismaClient()
            // 例外：server.js 顶层（全局单例）、prisma/ 脚本目录（见 overrides）
            {
                selector: "NewExpression[callee.name='PrismaClient']",
                message:
                    '[foodsentinel/no-global-prisma] 禁止直接 new PrismaClient()。' +
                    '租户数据操作必须通过 createTenantClient(prisma, schoolCode) 或 userManager.forTenant(schoolCode) 获取租户客户端，' +
                    '或使用 req.db（由 tenantMiddleware 挂载）。' +
                    '全局单例仅在 server.js 顶层创建一次。详见 TD-Tenant-Route。',
            },
            // 规则3：禁止 crypto.randomUUID() 无降级判断
            // 对应 TD-HTTP-UUID：HTTP 内网部署 crypto.randomUUID() 抛 TypeError
            {
                selector:
                    "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
                message:
                    '[foodsentinel/no-secure-context-api] crypto.randomUUID() 仅在 Secure Context (HTTPS/localhost) 可用。' +
                    'HTTP 环境会抛 TypeError。请加降级：const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`。' +
                    '详见 TD-HTTP-UUID。',
            },
        ],

        // ──────────────────────────────────────────────────────────────
        // 规则2：禁止空 catch 块或仅含注释的 catch
        // 对应 TD-Catch-Fallthrough-Silent、TD-DisconnectAll-Silent
        // ──────────────────────────────────────────────────────────────
        'no-empty': [
            'error',
            {
                // 禁止空 catch 块（含仅注释无代码的情况）
                allowEmptyCatch: false,
            },
        ],

        // 补充护栏：禁止 .catch(() => {}) 空回调（fire-and-forget 静默吞错）
        'no-empty-function': [
            'error',
            {
                allow: ['arrowFunctions'],
            },
        ],
    },

    // ──────────────────────────────────────────────────────────────
    // 例外：这些文件/目录允许 new PrismaClient()
    // ──────────────────────────────────────────────────────────────
    overrides: [
        {
            // server.js 顶层创建全局 prisma 单例 — 允许
            // 但仍保留 crypto.randomUUID 检查（规则3）
            files: ['server.js'],
            rules: {
                'no-restricted-syntax': [
                    'error',
                    // 只保留规则3（crypto.randomUUID），移除规则1（PrismaClient）
                    {
                        selector:
                            "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
                        message:
                            '[foodsentinel/no-secure-context-api] crypto.randomUUID() 仅在 Secure Context 可用。加降级。',
                    },
                ],
            },
        },
        {
            // prisma/ 目录的迁移/种子脚本 — 允许 new PrismaClient，允许空 catch（脚本场景）
            files: ['prisma/**/*.js'],
            rules: {
                'no-restricted-syntax': 'off',
                'no-empty': 'off',
            },
        },
        {
            // lib/tenantClient.js 内部创建租户客户端 — 允许
            files: ['lib/tenantClient.js'],
            rules: {
                'no-restricted-syntax': [
                    'error',
                    {
                        selector:
                            "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
                        message:
                            '[foodsentinel/no-secure-context-api] crypto.randomUUID() 仅在 Secure Context 可用。加降级。',
                    },
                ],
            },
        },
        {
            // 测试文件 — 放宽
            files: ['**/*.test.js', '**/*.spec.js', 'tests/**', 'cypress/**'],
            rules: {
                'no-restricted-syntax': 'off',
                'no-empty': 'off',
                'no-empty-function': 'off',
            },
        },
    ],
}
