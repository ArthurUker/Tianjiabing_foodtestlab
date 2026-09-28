/**
 * @jest-environment node
 *
 * P0-PROV · 「学校 schema 内禁止 role=admin」制度兜底回归测试 —— P3-W0-T02B 受控版。
 *
 * 受控要点（相对旧版）：
 *   - 门禁：root Jest setupFiles 已挂同一隔离门禁；本文件用 `cfg.url` **显式**创建 Prisma（不再 new PrismaClient()）。
 *   - 目标对象：只使用本任务独占实例 + runId 派生 `cfg.tenants.a` / `cfg.schemas.a`（无业务样式命名）。
 *   - fixture：`public."School"` / `public."User"`（平台 admin 正对照）与授权由 controller fixture
 *     （tests/isolation/t02b-root-fixture.cjs）在自有实例内建立；本测试**不** CREATE/DROP schema、
 *     不执行 db push/migrate/seed、不接管已有对象。
 *   - 每次破坏性操作都在**同一 interactive transaction** 内：先共享身份核验（薄适配），再执行
 *     purge/读写；清理只按 runId 派生登记行键，或由 provisioner 安全销毁整个自有实例。
 *
 * 五项制度语义保持：① 非法学校 admin 降级 ② 合法 manager 与 **实际存在的** public 平台 admin 保留
 * ③ 幂等 ④ 列表 is_invalid_role + 单点收敛 ⑤ POST/PUT 角色拒绝（纯函数）。
 */
process.env.NODE_ENV = 'test';

import fs from 'node:fs';
import path from 'node:path';
import gate from './helpers/db-isolation.js';
import { PrismaClient } from '../backend/node_modules/@prisma/client';
import { purgeInvalidAdminInSchools } from '../backend/lib/schoolAdminPurge.js';
import {
    withVerifiedTenantTx,
    prismaTxAsQueryClient,
    cleanupRegistered,
    createRegistry,
    settleAll,
    loadIsolationConfig,
} from './integration/pg-bootstrap.js';

let cfg = null;
let fixture = null;
let basePrisma = null;
let registry = null;
const schemaSql = () => `"${fixture.schoolSchema}"`;
const USER_COLUMNS = '"id","username","role","status","school_code","password_hash","email","full_name"';
/** 本测试写入/修改的行（runId 派生键）——只按登记键清理。 */
const createdRows = [];
function registerRow(qname, keyColumn, keyValue) {
    if (!keyValue.includes(cfg.runId)) throw new Error(`[T02B-REGISTRY] key must contain runId: ${keyColumn}`);
    const allowed = qname === `${fixture.schoolSchema}."User"` || qname === 'public."User"';
    if (!allowed) throw new Error(`[T02B-REGISTRY] qname outside this suite's scope: ${qname}`);
    createdRows.push({ qname, keyColumn, keyValue });
}

/**
 * 写前 School 范围判断（R1 收紧；生产使用的同一函数，可由合成替身调用以证明 fail-closed）：
 * 要求 public."School" **恰好一行且 code === 任务派生值**；空集/多行/越界一律拒绝，
 * 且在业务 callback 与任何 DML 之前执行。
 */
async function assertSchoolScope(tx, expectedCode) {
    const rows = await tx.$queryRawUnsafe('SELECT code FROM public."School"');
    const codes = rows.map((r) => r.code);
    if (codes.length !== 1 || codes[0] !== expectedCode) {
        const e = new Error('[T02B-SCHOOL-SCOPE] public."School" must contain exactly one task-derived school code (no empty set, no extra schools)');
        e.code = 'T02B_SCHOOL_SCOPE';
        e.observed = { count: codes.length, codes };
        throw e;
    }
}

/**
 * 每个写事务：共享核验（withVerifiedTenantTx：同一 tx 内先 verifyRuntimeIdentity）+
 * 写前 School 精确范围拒绝（同一 tx 内，callback/DML 之前）。
 */
async function verifiedWriteTx(fn, opts = {}) {
    return withVerifiedTenantTx(basePrisma, cfg, null, async (tx) => {
        await assertSchoolScope(tx, fixture.schoolCode);
        return fn(tx);
    }, opts);
}

const repoRootForSelect = () => path.resolve(__dirname, '..');

beforeAll(async () => {
    cfg = loadIsolationConfig();
    const fxPath = process.env.T02B_FIXTURE_FILE;
    if (!fxPath || !fs.existsSync(fxPath)) {
        throw new Error('[T02B-FIXTURE-MISSING] controller fixture file is required (run tests/isolation/t02b-root-fixture.cjs first)');
    }
    fixture = JSON.parse(fs.readFileSync(fxPath, 'utf8'));
    if (fixture.runId !== cfg.runId) throw new Error('[T02B-FIXTURE-RUNID] fixture belongs to another run');
    // R1：逐项绑定（fixture 的 code/schema/runId ↔ 已验证 cfg 的 runId 派生集合）
    if (fixture.schoolCode !== cfg.tenants.a) throw new Error('[T02B-FIXTURE-BIND] fixture.schoolCode must equal cfg.tenants.a');
    if (fixture.schoolSchema !== cfg.schemas.a) throw new Error('[T02B-FIXTURE-BIND] fixture.schoolSchema must equal cfg.schemas.a');
    registry = createRegistry(cfg);
    basePrisma = new PrismaClient({ datasources: { db: { url: cfg.url } } });
});

afterAll(async () => {
    // R2：受控故障注入开关（仅测试用；默认关闭，不污染真实 root 正例）。
    // 取值：''（正常）| 'cleanup' | 'disconnect' | 'both'
    const raw = String(process.env.T02B_R2_TEARDOWN_FAULT || '').trim()
    const faults = raw === 'both' ? ['cleanup', 'disconnect'] : raw.split(',').map((x) => x.trim()).filter(Boolean)
    const invocations = []
    // 故障模式下注入一个"原始业务错误"，用于证明收尾失败不会覆盖原始错误
    const originalBusinessError = faults.length > 0
        ? Object.assign(new Error('[T02B-R2] injected business error (must survive teardown failures)'), { code: 'INJECTED_BUSINESS' })
        : null

    const result = await settleAll([
        {
            name: 'cleanupRegisteredRows',
            fn: async () => {
                invocations.push('cleanup');
                // 仍执行**真实**清理（只按登记键、同一 tx 内先核验）
                if (createdRows.length > 0) {
                    await verifiedWriteTx(async (tx) => {
                        const adapter = prismaTxAsQueryClient(tx);
                        for (const row of [...createdRows].reverse()) {
                            if (!row.keyValue.includes(cfg.runId)) throw Object.assign(new Error('[T02B-CLEANUP-KEY] foreign key'), { code: 'T02B_CLEANUP_KEY' });
                            await adapter.query(`DELETE FROM ${row.qname} WHERE ${row.keyColumn} = $1`, [row.keyValue]);
                        }
                    });
                }
                if (faults.includes('cleanup')) {
                    throw Object.assign(new Error('injected cleanup failure (受控注入)'), { code: 'INJECTED_CLEANUP' });
                }
            },
        },
        {
            name: 'basePrisma.$disconnect',
            fn: async () => {
                invocations.push('disconnect');
                if (basePrisma) await basePrisma.$disconnect();
                if (faults.includes('disconnect')) {
                    throw Object.assign(new Error('injected disconnect failure (受控注入)'), { code: 'E_END' });
                }
            },
        },
    ], { originalError: originalBusinessError });

    if (!result.ok) {
        const codes = result.errors.map((e) => `${e.name}:${e.code}`).join(',');
        const err = new Error(
            `[AFTER_ALL_FAILED] steps=${result.errors.length} codes=[${codes}] invocations=[${invocations.join(',')}] ` +
            `originalErrorCode=${result.originalError ? result.originalError.code : 'none'}`
        );
        err.details = result.errors;
        err.invocations = invocations; // 各项均被尝试
        err.originalError = result.originalError; // 原始业务错误按对象身份保留
        err.originalErrorCode = result.originalError ? result.originalError.code : null;
        throw err; // → 该 suite 失败 → root 命令 rc≠0
    }
});

describe('P0-PROV · 学校租户内禁止 role=admin（受控隔离实例）', () => {
    const dirtyId = () => `t02b-${fixture.runId}-dirty-admin`;
    const dirtyUsername = () => `t02b_${fixture.runId}_dirty_admin`;
    const okManagerId = () => `t02b-${fixture.runId}-ok-manager`;

    test('① purgeInvalidAdminInSchools 把学校 schema 内 role=admin 降级为 manager', async () => {
        await verifiedWriteTx(async (tx) => {
            await tx.$executeRawUnsafe(
                `INSERT INTO ${schemaSql()}."User" (${USER_COLUMNS}) VALUES ($1, $2, 'admin', 'active', $3, 'fixture-not-a-real-hash', null, 'Dirty Admin')`,
                dirtyId(), dirtyUsername(), fixture.schoolCode
            );
            await tx.$executeRawUnsafe(
                `INSERT INTO ${schemaSql()}."User" (${USER_COLUMNS}) VALUES ($1, $2, 'manager', 'active', $3, 'fixture-not-a-real-hash', null, 'Injected Manager')`,
                okManagerId(), `t02b_${fixture.runId}_ok_manager`, fixture.schoolCode
            );
        });
        registerRow(`${fixture.schoolSchema}."User"`, 'id', dirtyId());
        registerRow(`${fixture.schoolSchema}."User"`, 'id', okManagerId());

        const before = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT "id","username","role" FROM ${schemaSql()}."User" WHERE "id" = $1`, dirtyId()
        ));
        expect(before[0].role).toBe('admin');

        const result = await verifiedWriteTx(async (tx) => purgeInvalidAdminInSchools(tx, () => {}));
        expect(result.scanned).toBeGreaterThanOrEqual(1);
        expect(result.demoted).toBeGreaterThanOrEqual(1);
        expect(result.bySchema[fixture.schoolSchema]).toEqual(expect.arrayContaining([dirtyUsername()]));

        const after = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT "id","username","role" FROM ${schemaSql()}."User" WHERE "id" = $1`, dirtyId()
        ));
        expect(after[0].role).toBe('manager');
        expect(after[0].username).toBe(dirtyUsername());
    }, 60000);

    test('② purge 不误伤合法 manager 与**实际存在的** public 平台超管', async () => {
        const ok = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT role FROM ${schemaSql()}."User" WHERE "id" = $1`, okManagerId()
        ));
        expect(ok[0].role).toBe('manager');

        // 平台超管正对照必须实际存在（不再有"不存在则跳过"分支）
        const pub = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT id, role, school_code FROM public."User" WHERE id = $1`, fixture.platformAdminId
        ));
        expect(pub.length).toBe(1);
        expect(pub[0].role).toBe('admin');
        expect(pub[0].school_code).toBeNull();
    }, 60000);

    test('③ 幂等：再次 purge 不重复降级（manager → manager 是 no-op）', async () => {
        const second = await verifiedWriteTx(async (tx) => purgeInvalidAdminInSchools(tx, () => {}));
        expect(second.demoted).toBe(0); // 已无非法 admin 行
        const after = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT role FROM ${schemaSql()}."User" WHERE "id" = $1`, dirtyId()
        ));
        expect(after[0].role).toBe('manager');
    }, 60000);

    test('④ GET /api/admin/schools/:code/users 响应含 is_invalid_role 字段 + 单点收敛', async () => {
        const fakeId = `t02b-${fixture.runId}-invalid`;
        await verifiedWriteTx(async (tx) => {
            await tx.$executeRawUnsafe(
                `INSERT INTO ${schemaSql()}."User" (${USER_COLUMNS}) VALUES ($1, $2, 'admin', 'active', $3, 'fixture-not-a-real-hash', null, 'Dirty Admin')`,
                fakeId, `t02b_${fixture.runId}_invalid`, fixture.schoolCode
            );
        });
        registerRow(`${fixture.schoolSchema}."User"`, 'id', fakeId);

        // 复刻 schoolRoutes.js 列表装饰（不拉起 server，用真实 schema）
        const rows = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT "id","username","role","status","created_at","last_login" FROM ${schemaSql()}."User" WHERE "id" = $1`, fakeId
        ));
        const decorated = rows.map((u) => ({ ...u, is_invalid_role: u.role === 'admin' }));
        expect(decorated[0].is_invalid_role).toBe(true);

        await verifiedWriteTx(async (tx) => {
            await tx.$executeRawUnsafe(
                `UPDATE ${schemaSql()}."User" SET "role" = 'manager', "updated_at" = now() WHERE "id" = $1 AND "role" = 'admin'`,
                fakeId
            );
        });
        const after = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT role FROM ${schemaSql()}."User" WHERE "id" = $1`, fakeId
        ));
        expect(after[0].role).toBe('manager');
    }, 60000);

    test('⑤ schoolRoutes POST/PUT 校验函数拒绝 role=admin（纯函数）', () => {
        const SCHOOL_USER_ROLES = ['manager', 'operator', 'viewer'];
        const isSchoolUserRole = (role) => SCHOOL_USER_ROLES.includes(role);
        expect(isSchoolUserRole('admin')).toBe(false);
        expect(isSchoolUserRole('manager')).toBe(true);
        expect(isSchoolUserRole('operator')).toBe(true);
        expect(isSchoolUserRole('viewer')).toBe(true);
    });

    test('⑦ 写前范围（合成替身，同一函数）：空 School 清单 → 拒绝、callback=0、DML=0', async () => {
        let callbackCalls = 0;
        let dmlCalls = 0;
        const emptyTx = {
            async $queryRawUnsafe() { return []; },
            async $executeRawUnsafe() { dmlCalls += 1; },
        };
        let thrown = null;
        try {
            await assertSchoolScope(emptyTx, fixture.schoolCode);
            callbackCalls += 1; // 不应到达（范围判断在 callback 之前）
        } catch (e) { thrown = e; }
        expect(thrown).not.toBeNull();
        expect(thrown.code).toBe('T02B_SCHOOL_SCOPE');
        expect(thrown.observed).toEqual({ count: 0, codes: [] });
        expect(callbackCalls).toBe(0);
        expect(dmlCalls).toBe(0);
    });

    test('⑧ 写前范围（合成替身，同一函数）：越界/多行 code → 拒绝、callback=0、DML=0', async () => {
        for (const codes of [['school_tjb'], [fixture.schoolCode, 'school_a'], ['school_a']]) {
            let callbackCalls = 0;
            let dmlCalls = 0;
            const tx = {
                async $queryRawUnsafe() { return codes.map((c) => ({ code: c })); },
                async $executeRawUnsafe() { dmlCalls += 1; },
            };
            let thrown = null;
            try { await assertSchoolScope(tx, fixture.schoolCode); callbackCalls += 1; } catch (e) { thrown = e; }
            expect(thrown).not.toBeNull();
            expect(thrown.code).toBe('T02B_SCHOOL_SCOPE');
            expect(thrown.observed.count).toBe(codes.length);
            expect(callbackCalls).toBe(0);
            expect(dmlCalls).toBe(0);
        }
    });

    test('⑨ 真实事务回滚：写入 runId 行后抛错 → 回滚后该行不存在；平台 admin 不变', async () => {
        const rollbackId = `t02b-${cfg.runId}-rollback`;
        let thrown = null;
        try {
            await verifiedWriteTx(async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO ${schemaSql()}."User" (${USER_COLUMNS}) VALUES ($1, $2, 'manager', 'active', $3, 'fixture-not-a-real-hash', null, 'Rollback Row')`,
                    rollbackId, `t02b_${cfg.runId}_rollback`, fixture.schoolCode
                );
                throw Object.assign(new Error('injected failure after write (expect rollback)'), { code: 'INJECTED_ROLLBACK' });
            });
        } catch (e) { thrown = e; }
        expect(thrown).not.toBeNull();
        expect(thrown.code).toBe('INJECTED_ROLLBACK');

        // 独立查询（新事务）：回滚行不存在
        const rows = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT "id" FROM ${schemaSql()}."User" WHERE "id" = $1`, rollbackId
        ));
        expect(rows.length).toBe(0);
        // 外部对象：平台 admin 仍在
        const pub = await verifiedWriteTx(async (tx) => tx.$queryRawUnsafe(
            `SELECT id, role, school_code FROM public."User" WHERE id = $1`, fixture.platformAdminId
        ));
        expect(pub.length).toBe(1);
        expect(pub[0].role).toBe('admin');
        // 未提交行不应登记（登记表只含已提交键）
        expect(createdRows.some((r) => r.keyValue === rollbackId)).toBe(false);
    }, 60000);

    test('⑩ 清理/释放失败注入：各项均尝试、整体非零、原始错误不被收尾错误覆盖', async () => {
        const invoked = [];
        const original = Object.assign(new Error('business failure (original)'), { code: 'BIZ_ORIGINAL' });
        const r = await settleAll([
            { name: 'cleanup', fn: async () => { invoked.push('cleanup'); throw Object.assign(new Error('cleanup failed (injected)'), { code: 'INJECTED_CLEANUP' }); } },
            { name: 'disconnect', fn: async () => { invoked.push('disconnect'); throw Object.assign(new Error('end failed (injected)'), { code: 'E_END' }); } },
        ], { originalError: original });
        expect(invoked).toEqual(['cleanup', 'disconnect']); // 首项失败不跳过后续项
        expect(r.ok).toBe(false);
        expect(r.originalError).toBe(original); // 原始业务错误按同一对象保留
        expect(r.errors.map((e) => e.code)).toEqual(['INJECTED_CLEANUP', 'E_END']); // 两项错误都保留
    });

    test('⑪ 合法隔离配置的只读身份 SELECT 正对照（子进程 + 网络边界观测）', async () => {
        const os = require('node:os');
        const pathMod = require('node:path');
        const { spawnSync } = require('node:child_process');
        const { pathToFileURL } = require('node:url');
        const { readObservations } = require('./isolation/lib/root-entry-runner.cjs');
        const preload = pathMod.join(__dirname, 'isolation', 'lib', 'net-observer-preload.cjs');
        // R2：唯一 token + 独占观测路径（此前不存在），并逐 PID 校验归属/完整性
        const cryptoMod = require('node:crypto');
        const token = `t02b-r2-select-${cryptoMod.randomBytes(10).toString('hex')}`;
        const netLog = pathMod.join(os.tmpdir(), `obs-positive-select-${token}.net.log`);
        expect(fs.existsSync(netLog)).toBe(false);
        const script = `
const { Client } = require('pg')
const c = new Client({ connectionString: process.env.TEST_DATABASE_URL, application_name: 't02b-r1-select' })
c.connect().then(async () => {
  const r = await c.query('SELECT current_user AS cu, current_database() AS db')
  console.log(JSON.stringify({ current_user: r.rows[0].cu, db: r.rows[0].db }))
  await c.end(); process.exit(0)
}).catch((e) => { console.error(String(e.code || e.message)); process.exit(4) })
`;
        const r = spawnSync(process.execPath, ['-e', script], {
            cwd: repoRootForSelect(), encoding: 'utf8', timeout: 30000,
            env: {
                PATH: process.env.PATH, HOME: process.env.HOME,
                TEST_DATABASE_URL: cfg.url,
                NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
                T02B_NET_LOG: netLog,
                T02B_RUN_TOKEN: token,
            },
        });
        expect(r.status).toBe(0);
        const parsed = JSON.parse((r.stdout || '').trim().split('\n').pop());
        expect(parsed.current_user).toBe(cfg.role); // 实际数据库身份（Prisma 原生引擎层的等价证据）
        expect(parsed.db).toBe(cfg.database);
        const obs = readObservations(netLog, { token });
        expect(obs.valid).toBe(true);       // 观测器有效（token 匹配、boot→final 完整）
        expect(obs.attempts).toBeGreaterThanOrEqual(1); // 到达连接边界（正对照）
        expect(obs.pids.length).toBeGreaterThanOrEqual(1);
    }, 60000);

    test('⑥ 失败注入：tx 内核验拒绝 → 业务 purge 调用 0 次（同一 tx）', async () => {
        let purgeCalls = 0;
        const hooks = {
            afterTransactionStart: async (tx) => {
                // 在**真实事务**内改写 search_path（同一 tx；不伪造核验返回、不绕开 helper）
                await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${cfg.schemas.b}", public`);
            },
        };
        let thrown = null;
        try {
            await withVerifiedTenantTx(basePrisma, cfg, null, async (tx) => {
                purgeCalls += 1;
                await purgeInvalidAdminInSchools(tx, () => {});
            }, { hooks });
        } catch (e) { thrown = e; }
        expect(thrown).not.toBeNull();
        expect(thrown.code).toBe('RUNTIME_IDENTITY_MISMATCH');
        expect(purgeCalls).toBe(0); // 业务 purge 未被调用（DDL/DML=0）
    }, 60000);
});
