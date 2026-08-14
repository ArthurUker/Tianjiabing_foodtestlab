/**
 * @jest-environment node
 *
 * IF-3/REG-3 · 三源审计统一收口 + REG-4 · 平台超管删用户补审计 —— 回归测试
 *
 * 覆盖：
 *   1. 统一字段规范 v1：writeSystemLog 自动补齐 canonical 键（actor_id/action_type/
 *      target_id/ts），SECURITY:* 事件与 [admin-audit]* 事件均可被统一提取；
 *   2. 三源统一查询：角色变更（logAdminAction→租户 AuditLog）、记录删除
 *      （writeTenantAuditLog→租户 AuditLog）、安全事件（logSecurityEvent→public
 *      SystemLog）三类事件，经 UNION 等价查询（queryUnifiedAuditTrail）全部可检索；
 *   3. REG-4：writeAdminOpsLog 在操作者无租户归属（schoolCode=null 的平台超管）时
 *      正常写入 public.SystemLog 且字段完整；
 *   4. REG-4 静态回归：server.js 的 DELETE /api/admin/schools/:code/users/:userId
 *      删除成功分支调用 writeAdminOpsLog，且审计失败不影响删除响应（try/catch 包裹）；
 *   5. 调用方无感知：logAdminAction 签名不变，超管兜底路径经真实 writeSystemLog 后
 *      context 自动 canonical 化。
 *
 * 注意：本文件不 mock backend/lib/auditLog.js（验证真实写入层），仅 mock
 * tenantClient（避免加载 @prisma/client）与 authMiddleware（吊销链路非本轮对象）。
 */
import fs from 'fs';
import path from 'path';

jest.mock('../backend/lib/tenantClient.js', () => ({
    createTenantClient: (prisma) => prisma,
    isValidSchoolCode: (c) => typeof c === 'string' && /^[a-z0-9-]{1,40}$/.test(c),
    schemaNameOf: (c) => `school_${c}`,
    resolveSchemaName: () => 'public',
    assertSafeSchemaName: (n) => n,
    disconnectAllTenantClients: async () => {},
    DEFAULT_SCHEMA: 'public',
}));

jest.mock('../backend/middleware/authMiddleware.js', () => ({
    createAuthMiddleware: () => ({
        authenticateUser: (req, res, next) => next(),
        authorizeAdmin: (req, res, next) => next(),
    }),
    revokeAllUserTokens: jest.fn().mockResolvedValue(true),
}));

import { writeTenantAuditLog, writeSystemLog, writeAdminOpsLog } from '../backend/lib/auditLog.js';
import { UserManager } from '../backend/modules/UserManager.js';

// P1-4: details/context 列升级 jsonb 后，Prisma model 读取 Json 字段返回对象（不再返回 JSON 字符串）。
// 本 helper 兼容对象与字符串，供测试断言与真实 Prisma 行为对齐。
const parseJsonField = (v, fallback = {}) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
};

// ====== 内存存储 stub ======

/** 租户 schema stub：AuditLog 行存 auditRows */
function makeTenantPrisma(usersById, auditRows) {
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
        auditLog: {
            create: jest.fn(async ({ data }) => {
                const row = { id: `al-${auditRows.length + 1}`, created_at: new Date(), ...data };
                auditRows.push(row);
                return row;
            }),
        },
    };
}

/** public schema stub：SystemLog 行存 systemRows */
function makePublicPrisma(systemRows) {
    return {
        systemLog: {
            create: jest.fn(async ({ data }) => {
                const row = { id: `sl-${systemRows.length + 1}`, created_at: new Date(), ...data };
                systemRows.push(row);
                return row;
            }),
        },
    };
}

/**
 * 统一审计查询（UNION 等价实现，与 backend/lib/auditLog.js 文件头的 SQL 一一对应）：
 *   租户 AuditLog：  user_id→actor_id, action→action_type, resource_id→target_id
 *   public SystemLog：message LIKE 'SECURITY:%' / '[admin-audit]%'，canonical 键取自 context
 */
function queryUnifiedAuditTrail({ auditRows, systemRows }, actorId) {
    const fromTenant = auditRows
        .filter(r => r.user_id === actorId)
        .map(r => ({
            source: 'AuditLog',
            actor_id: r.user_id,
            action_type: r.action,
            target_id: r.resource_id,
            details_json: r.details,
            created_at: r.created_at,
        }));
    const fromSystem = systemRows
        .filter(r => r.message.startsWith('SECURITY:') || r.message.startsWith('[admin-audit]'))
        .map(r => {
            const ctx = parseJsonField(r.context);
            return {
                source: 'SystemLog',
                actor_id: ctx.actor_id ?? null,
                action_type: ctx.action_type ?? null,
                target_id: ctx.target_id ?? null,
                details_json: r.context,
                created_at: r.created_at,
            };
        })
        .filter(r => r.actor_id === actorId);
    return [...fromTenant, ...fromSystem].sort((a, b) => b.created_at - a.created_at);
}

const managerActor = { userId: 'u-mgr', username: 'mgr', role: 'manager', schoolCode: 'school-a', ip: '1.2.3.4' };
const platformAdminActor = { userId: 'u-root', username: 'root', role: 'admin', schoolCode: null, ip: '9.9.9.9' };

const usersById = () => ({
    'u-1': { id: 'u-1', username: 'op', role: 'operator', status: 'active', school_code: 'school-a' },
    'u-mgr': { id: 'u-mgr', username: 'mgr', role: 'manager', status: 'active', school_code: 'school-a' },
});

function buildTenantUM(auditRows, systemRows, users = usersById()) {
    const tenantPrisma = makeTenantPrisma(users, auditRows);
    const um = new UserManager(tenantPrisma, 'test-secret');
    um.schoolCode = 'school-a';
    um.rootPrisma = makePublicPrisma(systemRows); // rootPrisma 连 public
    return { um, tenantPrisma };
}

beforeEach(() => jest.clearAllMocks());

// ====== 1. 统一字段规范 v1：writeSystemLog canonical 化 ======

describe('统一字段规范 v1 · writeSystemLog 自动补齐 canonical 键', () => {
    test('SECURITY:* 事件：actorId→actor_id、userId→target_id、message 前缀→action_type、timestamp→ts，原始键保留', async () => {
        const systemRows = [];
        const prisma = makePublicPrisma(systemRows);
        await writeSystemLog(prisma, {
            level: 'error',
            message: 'SECURITY:REVOCATION_WRITE_FAILED',
            context: { userId: 'u-1', actorId: 'u-mgr', reason: 'role_change', error: 'db down', timestamp: '2026-07-30T00:00:00.000Z' },
        });
        const ctx = parseJsonField(systemRows[0].context);
        expect(ctx).toMatchObject({
            actor_id: 'u-mgr',
            target_id: 'u-1',
            action_type: 'SECURITY:REVOCATION_WRITE_FAILED',
            ts: '2026-07-30T00:00:00.000Z',
            // 原始键不丢（既有消费方无感知）
            userId: 'u-1',
            actorId: 'u-mgr',
            error: 'db down',
        });
    });

    test('调用方已显式提供 canonical 键时不被覆盖', async () => {
        const systemRows = [];
        await writeSystemLog(makePublicPrisma(systemRows), {
            message: '[admin-audit] x target=y',
            context: { actor_id: 'explicit', actorId: 'legacy', action_type: 'custom_action' },
        });
        const ctx = parseJsonField(systemRows[0].context);
        expect(ctx.actor_id).toBe('explicit');
        expect(ctx.action_type).toBe('custom_action');
    });
});

// ====== 2. 三源统一查询（IF-3/REG-3 核心验收） ======

describe('IF-3/REG-3 · 三类事件经统一 UNION 查询均可检索', () => {
    test('角色变更 + 记录删除 + 安全事件 → queryUnifiedAuditTrail 三条全命中且字段完整', async () => {
        const auditRows = [];
        const systemRows = [];
        const { um } = buildTenantUM(auditRows, systemRows);

        // 事件1：角色变更（UserManager.changeUserRole → logAdminAction → 租户 AuditLog）
        await um.changeUserRole('u-1', 'viewer', managerActor);
        // 事件2：记录删除（server.js writeRecordAuditLog 的最终写入层 writeTenantAuditLog）
        await writeTenantAuditLog(um.prisma, {
            actorId: 'u-mgr', action: 'delete', resourceType: 'test_record',
            resourceId: 'rec-1', details: { record_code: 'RC-1' }, ip: '1.2.3.4',
        });
        // 事件3：安全事件（logSecurityEvent → public SystemLog）
        await um.logSecurityEvent('REFRESH_TOKEN_REPLAY', { userId: 'u-9', actorId: 'u-mgr', jti: 'jti-x' });

        const trail = queryUnifiedAuditTrail({ auditRows, systemRows }, 'u-mgr');
        expect(trail).toHaveLength(3);
        const byAction = Object.fromEntries(trail.map(r => [r.action_type, r]));

        expect(byAction['role_change']).toMatchObject({ source: 'AuditLog', actor_id: 'u-mgr', target_id: 'u-1' });
        expect(parseJsonField(byAction['role_change'].details_json)).toMatchObject({ oldRole: 'operator', newRole: 'viewer' });

        expect(byAction['delete']).toMatchObject({ source: 'AuditLog', actor_id: 'u-mgr', target_id: 'rec-1' });

        expect(byAction['SECURITY:REFRESH_TOKEN_REPLAY']).toMatchObject({ source: 'SystemLog', actor_id: 'u-mgr', target_id: 'u-9' });
        trail.forEach(r => expect(r.created_at).toBeInstanceOf(Date));
    });

    test('logAdminAction 签名不变：超管兜底路径（actor 不在租户 schema）落 SystemLog 且 canonical 化', async () => {
        const auditRows = [];
        const systemRows = [];
        const { um } = buildTenantUM(auditRows, systemRows); // users 不含 u-root
        await um.logAdminAction('user_disable', platformAdminActor, { targetUserId: 'u-1' });

        expect(auditRows).toHaveLength(0); // 未写租户表（外键会失败）
        expect(systemRows).toHaveLength(1);
        expect(systemRows[0].message).toBe('[admin-audit] user_disable target=u-1');
        const ctx = parseJsonField(systemRows[0].context);
        expect(ctx).toMatchObject({
            actor_id: 'u-root',
            actor_school_code: null,
            target_id: 'u-1',
            action_type: 'user_disable', // 由 message 前缀推导
        });
        // 统一查询同样可命中
        const trail = queryUnifiedAuditTrail({ auditRows, systemRows }, 'u-root');
        expect(trail).toHaveLength(1);
        expect(trail[0].action_type).toBe('user_disable');
    });
});

// ====== 3. REG-4 · writeAdminOpsLog（平台超管删用户审计） ======

describe('REG-4 · writeAdminOpsLog 平台级管理操作审计', () => {
    test('操作者无租户归属（schoolCode=null）→ 正常写入 public.SystemLog，字段完整', async () => {
        const systemRows = [];
        await writeAdminOpsLog(makePublicPrisma(systemRows), {
            action: 'admin_delete_school_user',
            actor: platformAdminActor,
            targetId: 'u-9',
            targetSchoolCode: 'school-b',
            details: { targetUsername: 'victim', targetRole: 'operator', targetStatus: 'active' },
        });

        expect(systemRows).toHaveLength(1);
        expect(systemRows[0].level).toBe('warn');
        expect(systemRows[0].message).toBe('[admin-audit] admin_delete_school_user target=u-9');
        const ctx = parseJsonField(systemRows[0].context);
        expect(ctx).toMatchObject({
            action_type: 'admin_delete_school_user',
            actor_id: 'u-root',
            actor_username: 'root',
            actor_role: 'admin',
            actor_school_code: null,   // 操作者无租户归属：不写错租户、不写失败
            target_id: 'u-9',
            target_school_code: 'school-b',
            targetUsername: 'victim',
            targetRole: 'operator',
            ip: '9.9.9.9',
        });
        expect(ctx.ts).toBeTruthy(); // 删除时间

        // 与超管其他管理操作共用 '[admin-audit]%' 前缀，统一查询可命中
        const trail = queryUnifiedAuditTrail({ auditRows: [], systemRows }, 'u-root');
        expect(trail).toHaveLength(1);
        expect(trail[0].action_type).toBe('admin_delete_school_user');
    });

    test('actor 完全缺省也不抛错（脚本直调兜底）', async () => {
        const systemRows = [];
        await expect(writeAdminOpsLog(makePublicPrisma(systemRows), {
            action: 'admin_delete_school_user', targetId: 'u-9',
        })).resolves.toBeTruthy();
        const ctx = parseJsonField(systemRows[0].context);
        expect(ctx.actor_id).toBeNull();
        expect(ctx.target_id).toBe('u-9');
    });
});

// ====== 4. REG-4 静态回归：DELETE 路由已接线（P1-5 拆路由后迁至 schoolRoutes.js） ======

describe('REG-4 · schoolRoutes.js DELETE /api/admin/schools/:code/users/:userId 静态回归', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../backend/routes/schoolRoutes.js'), 'utf8');
    const start = src.indexOf("router.delete('/api/admin/schools/:code/users/:userId'");
    const end = src.indexOf('router.', start + 10) > -1 ? src.indexOf('\n    router.', start) : src.length;
    const routeBlock = src.slice(start, end);

    test('路由存在且删除成功分支调用 writeAdminOpsLog（在 DELETE 语句之后）', () => {
        expect(start).toBeGreaterThan(-1);
        const deleteIdx = routeBlock.indexOf('DELETE FROM');
        const auditIdx = routeBlock.indexOf('writeAdminOpsLog');
        expect(deleteIdx).toBeGreaterThan(-1);
        expect(auditIdx).toBeGreaterThan(deleteIdx); // 删除成功后才审计
    });

    test('审计负载覆盖：操作者（平台超管）、目标用户、所属学校；且 try/catch 包裹（审计失败不影响删除响应）', () => {
        expect(routeBlock).toMatch(/action:\s*'admin_delete_school_user'/);
        expect(routeBlock).toMatch(/targetId:\s*userId/);
        expect(routeBlock).toMatch(/targetSchoolCode:\s*code/);
        expect(routeBlock).toMatch(/req\.user\?\.userId/);
        // writeAdminOpsLog 调用位于 try {...} catch 内
        expect(routeBlock).toMatch(/try\s*\{[\s\S]*writeAdminOpsLog[\s\S]*\}\s*catch/);
        // 目标用户名快照（SELECT 需含 username）
        expect(routeBlock).toMatch(/"username"/);
    });

    test('schoolRoutes.js 已从统一门面导入 writeAdminOpsLog', () => {
        expect(src).toMatch(/import\s*\{[^}]*writeAdminOpsLog[^}]*\}\s*from\s*'\.\.\/lib\/auditLog\.js'/);
    });
});

// ====== 5. 第七轮收尾 · 事项一：BS-11 界面定制审计改走统一门面 ======

describe('第七轮收尾 · BS-11 update_customization 审计经统一门面可被 UNION 查询检索', () => {
    test('功能回归：writeAdminOpsLog(update_customization) → canonical 键齐全（actor_id 而非 actor）且统一查询命中', async () => {
        const systemRows = [];
        await writeAdminOpsLog(makePublicPrisma(systemRows), {
            action: 'update_customization',
            level: 'info',
            actor: platformAdminActor,
            targetId: 'school-a',
            targetSchoolCode: 'school-a',
            details: { changedFields: ['theme_config', 'welcome_text'] },
        });

        expect(systemRows).toHaveLength(1);
        expect(systemRows[0].level).toBe('info');
        expect(systemRows[0].message).toBe('[admin-audit] update_customization target=school-a');
        const ctx = parseJsonField(systemRows[0].context);
        expect(ctx).toMatchObject({
            action_type: 'update_customization',
            actor_id: 'u-root',              // canonical 键：actor_id（修复前为非规范键 actor）
            actor_username: 'root',
            target_id: 'school-a',
            target_school_code: 'school-a',
            changedFields: ['theme_config', 'welcome_text'],
        });
        expect(ctx.actor).toBeUndefined();   // 旧的非 canonical 键不再出现

        // 核心验收：本条记录能被本轮建立的 UNION 统一查询检索到
        const trail = queryUnifiedAuditTrail({ auditRows: [], systemRows }, 'u-root');
        expect(trail).toHaveLength(1);
        expect(trail[0]).toMatchObject({ source: 'SystemLog', action_type: 'update_customization', target_id: 'school-a' });
    });

    test('静态回归：customization 路由块调用 writeAdminOpsLog，不再裸写 systemLog.create', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../backend/routes/schoolRoutes.js'), 'utf8');
        const start = src.indexOf("router.put('/api/admin/schools/:code/customization'");
        expect(start).toBeGreaterThan(-1);
        const end = src.indexOf('\n    router.', start);
        const routeBlock = src.slice(start, end > -1 ? end : src.length);

        expect(routeBlock).toMatch(/writeAdminOpsLog/);
        expect(routeBlock).toMatch(/action:\s*'update_customization'/);
        expect(routeBlock).not.toMatch(/systemLog\.create/);
        // 审计失败不阻断主流程（try/catch 包裹）
        expect(routeBlock).toMatch(/try\s*\{[\s\S]*writeAdminOpsLog[\s\S]*\}\s*catch/);
    });

    test('全文件回归：server.js / schoolRoutes.js 不存在任何裸写 prisma.systemLog.create / prisma.auditLog.create', () => {
        const serverSrc = fs.readFileSync(path.resolve(__dirname, '../backend/server.js'), 'utf8');
        const schoolSrc = fs.readFileSync(path.resolve(__dirname, '../backend/routes/schoolRoutes.js'), 'utf8');
        expect(serverSrc).not.toMatch(/prisma\.systemLog\.create/);
        expect(serverSrc).not.toMatch(/\.auditLog\.create\(/);
        expect(schoolSrc).not.toMatch(/prisma\.systemLog\.create/);
        expect(schoolSrc).not.toMatch(/\.auditLog\.create\(/);
    });
});
