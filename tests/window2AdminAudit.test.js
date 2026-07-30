/**
 * @jest-environment node
 *
 * 窗口2「角色变更与审计完整性」回归测试
 *
 * 覆盖交付要求中的回归场景：
 *   1. P0  · manager 提权 admin → 403（changeUserRole / adminUpdateUser）
 *   2. P0  · 租户上下文不变量：任何人（含平台超管）不可在租户内设置 admin
 *   3. P0-3· seed.js 创建平台超管不经过 changeUserRole（静态回归）
 *   4. H4  · 角色变更/禁用/启用/删除/重置密码成功后，服务端强制写入审计
 *   5. H4  · 操作者不在当前 schema（平台超管操作租户）→ 回退 SystemLog，事件不丢
 *   6. M3  · 最后一名可用 manager 降权/禁用/删除 → 403
 *   7. H3  · POST /api/audit-logs：guest/viewer → 403；非白名单 action → 400；
 *            合法上报 → 201 且 details 打 source:'client' 标记
 *   8. M1  · 缺少 SEED_ADMIN_PASSWORD 时建校（provisionSchool）直接失败
 *   9. M2  · resetPassword 置 must_change_password=true
 */
import fs from 'fs';
import path from 'path';
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
            req.db = { auditLog: { findMany: jest.fn(), count: jest.fn() } };
            next();
        },
        authorizeAdmin: (req, res, next) => next(),
    }),
    // IF-1: UserManager 现从 authMiddleware 导入吊销函数（高危操作后吊销全部会话）
    revokeAllUserTokens: jest.fn().mockResolvedValue(true),
}));

import { execFileSync } from 'child_process';
import { writeTenantAuditLog, writeSystemLog } from '../backend/lib/auditLog.js';
import { UserManager } from '../backend/modules/UserManager.js';
import { createAuditRoutes } from '../backend/routes/auditRoutes.js';

// ====== 测试基建 ======

function mockPrisma(usersById = {}) {
    return {
        user: {
            findUnique: jest.fn(({ where }) =>
                Promise.resolve(
                    where.id ? (usersById[where.id] || null)
                        : Object.values(usersById).find(u => u.username === where.username) || null
                )
            ),
            update: jest.fn().mockResolvedValue({}),
            delete: jest.fn().mockResolvedValue({}),
            count: jest.fn().mockResolvedValue(2),
        },
        testRecord: { count: jest.fn().mockResolvedValue(0) },
    };
}

/** 构造绑定租户上下文的 UserManager（不走 createTenantClient，直接注入 mock prisma） */
function tenantUM(prisma, schoolCode = 'school-a') {
    const um = new UserManager(prisma, 'test-secret');
    um.schoolCode = schoolCode;
    return um;
}

const managerActor = { userId: 'u-mgr', username: 'mgr', role: 'manager', schoolCode: 'school-a', ip: '1.2.3.4' };
const platformAdminActor = { userId: 'u-root', username: 'root', role: 'admin', schoolCode: null, ip: '9.9.9.9' };

beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALLOW_INSECURE_TENANT_PASSWORD;
});

// ====== 1/2. P0 提权拦截 ======

describe('P0 · changeUserRole / adminUpdateUser 提权拦截', () => {
    test('修复前可复现：manager 将本校用户提权为 admin → 现在 403', async () => {
        const prisma = mockPrisma({ 'u-1': { id: 'u-1', username: 'op', role: 'operator', status: 'active', school_code: 'school-a' } });
        const um = tenantUM(prisma);
        await expect(um.changeUserRole('u-1', 'admin', managerActor))
            .rejects.toMatchObject({ status: 403 });
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('租户上下文不变量：即使操作者是平台超管，也不可在租户内设置 admin', async () => {
        const prisma = mockPrisma({ 'u-1': { id: 'u-1', role: 'operator', status: 'active' } });
        const um = tenantUM(prisma);
        await expect(um.changeUserRole('u-1', 'admin', platformAdminActor))
            .rejects.toMatchObject({ status: 403 });
    });

    test('adminUpdateUser 同一守卫：manager 提交 role=admin → 403', async () => {
        const prisma = mockPrisma({ 'u-1': { id: 'u-1', username: 'op', role: 'operator', status: 'active' } });
        const um = tenantUM(prisma);
        await expect(um.adminUpdateUser('u-1', { role: 'admin' }, managerActor))
            .rejects.toMatchObject({ status: 403 });
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    test('actor 缺省（脚本直调）按最小权限：授予 admin → 403', async () => {
        const prisma = mockPrisma({ 'u-1': { id: 'u-1', role: 'operator', status: 'active' } });
        const um = new UserManager(prisma, 'test-secret'); // public/共享 schema
        await expect(um.changeUserRole('u-1', 'admin'))
            .rejects.toMatchObject({ status: 403 });
    });

    test('public schema 中平台超管可授予 admin（不误伤合法路径）', async () => {
        const usersById = {
            'u-1': { id: 'u-1', username: 'op', role: 'operator', status: 'active', school_code: null },
            'u-root': { id: 'u-root', username: 'root', role: 'admin', status: 'active', school_code: null },
        };
        const prisma = mockPrisma(usersById);
        const um = new UserManager(prisma, 'test-secret');
        const result = await um.changeUserRole('u-1', 'admin', platformAdminActor);
        expect(result.success).toBe(true);
        expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { role: 'admin' },
        }));
    });

    test('普通角色变更（manager 将 operator 设为 viewer）不受拦截', async () => {
        const usersById = {
            'u-1': { id: 'u-1', username: 'op', role: 'operator', status: 'active', school_code: 'school-a' },
            'u-mgr': { id: 'u-mgr', username: 'mgr', role: 'manager', status: 'active', school_code: 'school-a' },
        };
        const prisma = mockPrisma(usersById);
        const um = tenantUM(prisma);
        const result = await um.changeUserRole('u-1', 'viewer', managerActor);
        expect(result.success).toBe(true);
    });
});

// ====== 3. P0-3 seed 路径回归 ======

describe('P0-3 · seed.js 创建平台超管不经过 changeUserRole', () => {
    test('seed.js 使用 upsert 直写，不调用 changeUserRole/adminUpdateUser（不受提权拦截影响）', () => {
        const seedSrc = fs.readFileSync(
            path.resolve(__dirname, '../backend/prisma/seed.js'), 'utf8'
        );
        expect(seedSrc).not.toMatch(/changeUserRole|adminUpdateUser/);
        // seed 通过 prisma 直写（create/upsert）创建平台超管，不经过 UserManager 守卫
        expect(seedSrc).toMatch(/user\.create|user\.upsert/);
    });
});

// ====== 4/5. H4 强制服务端审计 ======

describe('H4 · 高危操作强制服务端审计', () => {
    const usersById = () => ({
        'u-1': { id: 'u-1', username: 'op', role: 'operator', status: 'active', school_code: 'school-a' },
        'u-mgr': { id: 'u-mgr', username: 'mgr', role: 'manager', status: 'active', school_code: 'school-a' },
    });

    test('changeUserRole 成功 → AuditLog 记录 oldRole→newRole、操作者、IP', async () => {
        const prisma = mockPrisma(usersById());
        const um = tenantUM(prisma);
        await um.changeUserRole('u-1', 'viewer', managerActor);
        expect(writeTenantAuditLog).toHaveBeenCalledTimes(1);
        const [dbArg, payload] = writeTenantAuditLog.mock.calls[0];
        expect(dbArg).toBe(prisma);
        expect(payload).toMatchObject({
            actorId: 'u-mgr',
            action: 'role_change',
            resourceType: 'user',
            resourceId: 'u-1',
        });
        expect(payload.details).toMatchObject({
            oldRole: 'operator',
            newRole: 'viewer',
            actorRole: 'manager',
            ip: '1.2.3.4',
        });
        expect(payload.details.timestamp).toBeTruthy();
    });

    test.each([
        ['disableUser', (um) => um.disableUser('u-1', managerActor), 'user_disable'],
        ['enableUser', (um) => um.enableUser('u-1', managerActor), 'user_enable'],
        ['deleteUser', (um) => um.deleteUser('u-1', managerActor), 'user_delete'],
        ['resetPassword', (um) => um.resetPassword('u-1', 'NewPass123', managerActor), 'password_reset'],
    ])('%s 成功 → 审计表存在对应 action 记录', async (_name, run, expectedAction) => {
        const prisma = mockPrisma(usersById());
        const um = tenantUM(prisma);
        await run(um);
        expect(writeTenantAuditLog).toHaveBeenCalledWith(prisma, expect.objectContaining({
            action: expectedAction,
            actorId: 'u-mgr',
        }));
    });

    test('resetPassword 审计不包含密码明文/哈希', async () => {
        const prisma = mockPrisma(usersById());
        const um = tenantUM(prisma);
        await um.resetPassword('u-1', 'NewPass123', managerActor);
        const serialized = JSON.stringify(writeTenantAuditLog.mock.calls[0][1]);
        expect(serialized).not.toContain('NewPass123');
    });

    test('操作者不在当前 schema（平台超管操作租户）→ 回退写 SystemLog，事件不丢', async () => {
        // usersById 不含 u-root → logAdminAction 查不到 actor，走 SystemLog 兜底
        const prisma = mockPrisma(usersById());
        const um = tenantUM(prisma);
        await um.disableUser('u-1', { ...platformAdminActor });
        expect(writeTenantAuditLog).not.toHaveBeenCalled();
        expect(writeSystemLog).toHaveBeenCalledWith(um.rootPrisma, expect.objectContaining({
            message: expect.stringContaining('user_disable'),
        }));
    });

    test('审计写入失败不吞事件：回退 SystemLog', async () => {
        writeTenantAuditLog.mockRejectedValueOnce(new Error('db down'));
        const prisma = mockPrisma(usersById());
        const um = tenantUM(prisma);
        const result = await um.enableUser('u-1', managerActor);
        expect(result.success).toBe(true);
        expect(writeSystemLog).toHaveBeenCalled();
    });
});

// ====== 6. M3 最后一名 manager 保护 ======

describe('M3 · 最后一名可用 manager 保护', () => {
    const lastManagerDb = () => {
        const prisma = mockPrisma({
            'u-mgr': { id: 'u-mgr', username: 'mgr', role: 'manager', status: 'active', school_code: 'school-a' },
        });
        prisma.user.count.mockImplementation(({ where }) =>
            Promise.resolve(where && where.role === 'manager' ? 1 : 0)
        );
        return prisma;
    };

    test.each([
        ['降权（changeUserRole）', (um) => um.changeUserRole('u-mgr', 'operator', managerActor)],
        ['降权（adminUpdateUser role）', (um) => um.adminUpdateUser('u-mgr', { role: 'operator' }, managerActor)],
        ['禁用（disableUser）', (um) => um.disableUser('u-mgr', managerActor)],
        ['禁用（adminUpdateUser status）', (um) => um.adminUpdateUser('u-mgr', { status: 'disabled' }, managerActor)],
        ['删除（deleteUser）', (um) => um.deleteUser('u-mgr', managerActor)],
    ])('对最后一名 active manager %s → 403', async (_name, run) => {
        const prisma = lastManagerDb();
        const um = tenantUM(prisma);
        await expect(run(um)).rejects.toMatchObject({ status: 403 });
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    test('存在第二名 active manager 时允许降权', async () => {
        const prisma = mockPrisma({
            'u-mgr': { id: 'u-mgr', username: 'mgr', role: 'manager', status: 'active', school_code: 'school-a' },
        });
        prisma.user.count.mockResolvedValue(2);
        const um = tenantUM(prisma);
        const result = await um.changeUserRole('u-mgr', 'operator', managerActor);
        expect(result.success).toBe(true);
    });
});

// ====== 7. H3 audit-logs 端点收敛 ======

describe('H3 · POST /api/audit-logs 收敛', () => {
    function buildApp() {
        const app = express();
        app.use(express.json());
        app.use('/api/audit-logs', createAuditRoutes({}, {}));
        return app;
    }
    const asUser = (u) => JSON.stringify(u);

    test.each(['guest', 'viewer'])('修复前可复现：%s 可写任意审计 → 现在 403', async (role) => {
        const res = await request(buildApp())
            .post('/api/audit-logs')
            .set('x-test-user', asUser({ userId: 'u-x', role }))
            .send({ action: 'delete', details: '伪造记录' });
        expect(res.status).toBe(403);
        expect(writeTenantAuditLog).not.toHaveBeenCalled();
    });

    test('非白名单 action（伪造服务端保留事件 login/role_change）→ 400', async () => {
        for (const action of ['login', 'login_failed', 'role_change', 'user_delete']) {
            const res = await request(buildApp())
                .post('/api/audit-logs')
                .set('x-test-user', asUser({ userId: 'u-op', role: 'operator' }))
                .send({ action });
            expect(res.status).toBe(400);
        }
        expect(writeTenantAuditLog).not.toHaveBeenCalled();
    });

    test('operator 上报白名单 action → 201，details 打 source:client 标记并限长', async () => {
        const res = await request(buildApp())
            .post('/api/audit-logs')
            .set('x-test-user', asUser({ userId: 'u-op', role: 'operator' }))
            .send({ action: 'export', resource_type: 'test_record', details: 'x'.repeat(5000) });
        expect(res.status).toBe(201);
        const payload = writeTenantAuditLog.mock.calls[0][1];
        expect(payload.details.source).toBe('client');
        expect(payload.details.text.length).toBeLessThanOrEqual(2000);
    });
});

// ====== 8. M1 缺少初始密码建校失败 ======

describe('M1 · provisionSchool 弱默认密码回退移除', () => {
    // tenantProvisioner.js 使用 import.meta（原生 ESM），babel-CJS 管线无法直接 require，
    // 故通过 node --input-type=module 子进程验证真实模块行为。
    test('修复前可复现：无 SEED_ADMIN_PASSWORD 仍以 changeme 建校 → 现在直接 throw，且不创建 schema', () => {
        const script = `
            import { provisionSchool } from './backend/lib/tenantProvisioner.js';
            const prisma = {
                $queryRawUnsafe: async () => [], // schema 不存在（全新建校）
                $executeRawUnsafe: async () => { console.log('SCHEMA_CREATED'); },
                $transaction: async () => { console.log('TX_RUN'); },
            };
            try {
                await provisionSchool({ prisma, code: 'newschool', adminPassword: '', databaseUrl: 'postgresql://u:p@localhost/db' });
                console.log('NO_THROW');
            } catch (e) {
                console.log('THREW:' + e.message);
            }
        `;
        const out = execFileSync('node', ['--input-type=module', '-e', script], {
            cwd: path.resolve(__dirname, '..'),
            env: { ...process.env, ALLOW_INSECURE_TENANT_PASSWORD: '' },
            encoding: 'utf8',
        });
        expect(out).toContain('THREW:');
        expect(out).toMatch(/缺少租户初始管理密码/);
        expect(out).not.toContain('SCHEMA_CREATED');
        expect(out).not.toContain('TX_RUN');
        expect(out).not.toContain('NO_THROW');
    });
});

// ====== 9. M2 must_change_password ======

describe('M2 · 临时密码账号强制改密标记', () => {
    test('resetPassword（管理员重置=临时密码）→ must_change_password 置 true', async () => {
        const prisma = mockPrisma({
            'u-1': { id: 'u-1', username: 'op', role: 'operator', status: 'active' },
            'u-mgr': { id: 'u-mgr', username: 'mgr', role: 'manager', status: 'active' },
        });
        const um = tenantUM(prisma);
        await um.resetPassword('u-1', 'NewPass123', managerActor);
        expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ must_change_password: true }),
        }));
    });

    test('provisionSchool 建号 SQL 含 must_change_password=true（静态回归）', () => {
        const src = fs.readFileSync(
            path.resolve(__dirname, '../backend/lib/tenantProvisioner.js'), 'utf8'
        );
        expect(src).toMatch(/must_change_password/);
        expect(src).not.toMatch(/adminPassword \|\| 'changeme'/);
    });
});
