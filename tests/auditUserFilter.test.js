/**
 * @jest-environment node
 *
 * 审计日志「按用户名筛选 + 用户下拉列表」端点回归测试
 *
 * 覆盖：
 *   1. GET /api/audit-logs?username=xxx —— admin/manager 按用户名过滤
 *      （Prisma 关系过滤 where.user.username，而非 cuid）；
 *   2. GET /api/audit-logs?userId=xxx   —— 按 user_id（cuid）过滤仍兼容；
 *   3. 普通用户（operator/viewer）无视 username 参数，强制只见本人日志；
 *   4. GET /api/audit-logs/users —— admin/manager 返回租户全部用户 + 审计中
 *      出现过但已被删除的 user_id（deletedIds），供前端下拉框展示；
 *   5. GET /api/audit-logs/users —— 非 admin/manager 仅返回本人（防枚举用户名）。
 *
 * 模式参考 tests/window2AdminAudit.test.js：mock authMiddleware + req.db。
 */
import express from 'express';
import request from 'supertest';

jest.mock('../backend/lib/auditLog.js', () => ({
    writeTenantAuditLog: jest.fn().mockResolvedValue({ id: 'log-1' }),
    writeSystemLog: jest.fn().mockResolvedValue({ id: 'syslog-1' }),
}));

jest.mock('../backend/middleware/authMiddleware.js', () => ({
    createAuthMiddleware: () => ({
        authenticateUser: (req, res, next) => {
            req.user = JSON.parse(req.headers['x-test-user'] || '{}');
            next();
        },
        authorizeAdmin: (req, res, next) => next(),
    }),
    revokeAllUserTokens: jest.fn().mockResolvedValue(true),
}));

import { createAuditRoutes } from '../backend/routes/auditRoutes.js';

// ====== 测试基建 ======

/** 内存 stub：user 表 + auditLog 表，支持 username/userId 过滤语义 */
function makeDb({ users = [], logs = [] } = {}) {
    const matchLog = (log, where = {}) => {
        if (where.user_id && log.user_id !== where.user_id) return false;
        if (where.user?.username && log.user?.username !== where.user.username) return false;
        if (where.action && log.action !== where.action) return false;
        return true;
    };
    return {
        user: {
            findMany: jest.fn(async ({ where } = {}) =>
                where && where.id ? users.filter(u => u.id === where.id) : users
            ),
        },
        auditLog: {
            findMany: jest.fn(async ({ where } = {}) => logs.filter(l => matchLog(l, where))),
            count: jest.fn(async ({ where } = {}) => logs.filter(l => matchLog(l, where)).length),
            groupBy: jest.fn(async () => [...new Set(logs.map(l => l.user_id))].map(user_id => ({ user_id }))),
        },
    };
}

function buildApp(db) {
    const app = express();
    app.use(express.json());
    // 挂载 mock db 到 req（须在路由之前注册）
    app.use((req, res, next) => { req.db = db; next(); });
    app.use('/api/audit-logs', createAuditRoutes({}, {}));
    return app;
}

const asUser = (u) => JSON.stringify(u);

const adminUser = { userId: 'u-admin', username: 'admin', role: 'admin', schoolCode: 'school-a' };
const operatorUser = { userId: 'u-op', username: 'op', role: 'operator', schoolCode: 'school-a' };

const sampleLogs = () => [
    { id: 'l1', user_id: 'u-renkang', action: 'login', created_at: '2026-08-01T01:00:00.000Z', user: { username: 'renkang', full_name: '任康' } },
    { id: 'l2', user_id: 'u-linjian', action: 'login', created_at: '2026-08-01T02:00:00.000Z', user: { username: 'linjian', full_name: '林健' } },
    { id: 'l3', user_id: 'u-renkang', action: 'export', created_at: '2026-08-02T01:00:00.000Z', user: { username: 'renkang', full_name: '任康' } },
];

beforeEach(() => jest.clearAllMocks());

// ====== 1. GET /api/audit-logs?username=xxx 按用户名过滤 ======

describe('审计日志 · 按用户名筛选（GET /api/audit-logs?username=）', () => {
    test('admin 传 username=renkang → 关系过滤 where.user.username，仅返回该用户日志', async () => {
        const db = makeDb({ logs: sampleLogs() });
        const res = await request(buildApp(db))
            .get('/api/audit-logs?username=renkang')
            .set('x-test-user', asUser(adminUser));

        expect(res.status).toBe(200);
        expect(db.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ user: { username: 'renkang' } }),
        }));
        expect(db.auditLog.findMany).toHaveBeenCalledWith(expect.not.objectContaining({
            where: expect.objectContaining({ user_id: expect.anything() }),
        }));
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data.every(l => l.user.username === 'renkang')).toBe(true);
        expect(res.body.total).toBe(2);
    });

    test('不传 username → 不加用户条件，返回全部日志', async () => {
        const db = makeDb({ logs: sampleLogs() });
        const res = await request(buildApp(db))
            .get('/api/audit-logs')
            .set('x-test-user', asUser(adminUser));

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(3);
        const whereArg = db.auditLog.findMany.mock.calls[0][0].where;
        expect(whereArg).not.toHaveProperty('user_id');
        expect(whereArg).not.toHaveProperty('user');
    });

    test('兼容保留：admin 传 userId（cuid）仍按 user_id 过滤', async () => {
        const db = makeDb({ logs: sampleLogs() });
        const res = await request(buildApp(db))
            .get('/api/audit-logs?userId=u-renkang')
            .set('x-test-user', asUser(adminUser));

        expect(res.status).toBe(200);
        expect(db.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ user_id: 'u-renkang' }),
        }));
        expect(res.body.data).toHaveLength(2);
    });

    test('普通用户（operator）即使传 username 也强制只见本人日志', async () => {
        const db = makeDb({ logs: sampleLogs() });
        const res = await request(buildApp(db))
            .get('/api/audit-logs?username=renkang')
            .set('x-test-user', asUser(operatorUser));

        expect(res.status).toBe(200);
        expect(db.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ user_id: operatorUser.userId }),
        }));
        // 不允许 username 绕过本人限制
        expect(db.auditLog.findMany.mock.calls[0][0].where).not.toHaveProperty('user');
    });
});

// ====== 2. GET /api/audit-logs/users 用户下拉列表 ======

describe('审计日志 · 用户列表（GET /api/audit-logs/users）', () => {
    const users = () => [
        { id: 'u-renkang', username: 'renkang', full_name: '任康', role: 'operator' },
        { id: 'u-linjian', username: 'linjian', full_name: '林健', role: 'manager' },
    ];
    // 审计中有 u-deleted（已被删除）的日志
    const logs = () => [
        ...sampleLogs(),
        { id: 'l4', user_id: 'u-deleted', action: 'login', created_at: '2026-07-01T00:00:00.000Z', user: null },
    ];

    test('admin：返回全部用户 + 审计中出现过但已删除的 user_id（deletedIds）', async () => {
        const db = makeDb({ users: users(), logs: logs() });
        const res = await request(buildApp(db))
            .get('/api/audit-logs/users')
            .set('x-test-user', asUser(adminUser));

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.users).toHaveLength(2);
        expect(res.body.data.users.map(u => u.username)).toEqual(['renkang', 'linjian']);
        // u-deleted 存在于审计但不在 user 表 → 进 deletedIds
        expect(res.body.data.deletedIds).toEqual(['u-deleted']);
        // user.findMany 不带 where（全量）
        expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: undefined }));
    });

    test('manager 与 admin 同权：返回全部用户 + deletedIds', async () => {
        const db = makeDb({ users: users(), logs: logs() });
        const manager = { userId: 'u-mgr', username: 'mgr', role: 'manager', schoolCode: 'school-a' };
        const res = await request(buildApp(db))
            .get('/api/audit-logs/users')
            .set('x-test-user', asUser(manager));

        expect(res.status).toBe(200);
        expect(res.body.data.users).toHaveLength(2);
        expect(res.body.data.deletedIds).toEqual(['u-deleted']);
    });

    test('普通用户：仅返回本人（防枚举用户名），deletedIds 为空', async () => {
        const db = makeDb({ users: users(), logs: logs() });
        const res = await request(buildApp(db))
            .get('/api/audit-logs/users')
            .set('x-test-user', asUser(operatorUser));

        expect(res.status).toBe(200);
        expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: operatorUser.userId },
        }));
        expect(res.body.data.users.every(u => u.id === operatorUser.userId)).toBe(true);
        expect(res.body.data.deletedIds).toEqual([]);
    });

    test('静态路由顺序：/users 不被 /:logId 动态路由吞掉', async () => {
        const db = makeDb({ users: users(), logs: logs() });
        // 若顺序错误会走到 :logId → auditLog.findUnique 抛错 → 400/404
        const res = await request(buildApp(db))
            .get('/api/audit-logs/users')
            .set('x-test-user', asUser(adminUser));
        expect(res.status).toBe(200);
        expect(res.body.data.users).toBeDefined();
    });
});
