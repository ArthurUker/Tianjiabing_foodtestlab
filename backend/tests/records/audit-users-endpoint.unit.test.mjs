// GET /api/audit-logs/users 端点单测（无 DB，handler 直调）
//
// 背景事故（2026-10-15，审查清单「审计页 400」）：原实现对非空字段 principal_id 使用
//   `{ not: null }` 过滤 → Prisma PrismaClientValidationError → 路由 catch 一律 400 →
//   控制台与学校审计视图的「操作人」下拉全部加载失败。修复 = 去掉该多余过滤
//   （principal_id NOT NULL 恒有值，`user_id: null` 即完整表达意图）。
// 本用例的 db 桩**模拟 Prisma 该校验行为**：见到 `principal_id.not === null` 即抛错，
// 从而把「非法过滤被 reintroduce」直接锁成测试失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuditRoutes } from '../../routes/auditRoutes.js'

/** 取出 router 上 /users 路由的最终 handler（跳过 authenticateUser 中间件）。 */
function usersHandler(router) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === '/users' && layer.route.methods.get) {
            return layer.route.stack[layer.route.stack.length - 1].handle
        }
    }
    throw new Error('路由未找到：GET /users')
}

function makeRes() {
    return {
        statusCode: 200, body: null,
        status(c) { this.statusCode = c; return this },
        json(b) { this.body = b; return this },
    }
}

/** 租户桩：模拟 Prisma 对 `{ not: null }` 于非空字段的校验失败（回归锁）。 */
function makeDb({ users = [{ id: 'u-1', username: 'alice', full_name: 'Alice', role: 'manager' }], principalGroups = [{ principal_id: 'p-1' }], principals = [{ subject_user_id: 'u-ghost' }] } = {}) {
    const calls = { userFindMany: [], groupBy: [], principalFindMany: [] }
    return {
        calls,
        user: {
            async findMany(args) {
                calls.userFindMany.push(args)
                return users
            },
        },
        auditLog: {
            async groupBy(args) {
                calls.groupBy.push(args)
                if (args?.where?.principal_id && args.where.principal_id.not === null) {
                    throw new Error('PrismaClientValidationError: Argument `not` must not be null.')
                }
                return args.by[0] === 'user_id' ? [{ user_id: null }] : principalGroups
            },
        },
        auditPrincipal: {
            async findMany(args) {
                calls.principalFindMany.push(args)
                return principals
            },
        },
    }
}

async function invoke(db, user) {
    const router = createAuditRoutes({}, {})
    const handler = usersHandler(router)
    const res = makeRes()
    await handler({ db, user, query: {} }, res)
    return res
}

test('admin：返回用户 + deletedIds，且 principal 分组只带 user_id:null（无 not:null 过滤）', async () => {
    const db = makeDb()
    const res = await invoke(db, { userId: 'su-1', role: 'admin', schoolCode: null })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.data.users.length, 1)
    assert.deepEqual(res.body.data.deletedIds, ['u-ghost'])
    // 回归锁：principal 分组过滤不得含 principal_id（原 bug 的 not:null 会在此抛错 → 400）
    const principalCall = db.calls.groupBy.find((c) => c.by[0] === 'principal_id')
    assert.ok(principalCall, '必须查询 principal 分组')
    assert.deepEqual(principalCall.where, { user_id: null })
    assert.equal(db.calls.principalFindMany[0].where.kind, 'user')
})

test('manager：与 admin 同权（isAdmin 含 manager）', async () => {
    const db = makeDb()
    const res = await invoke(db, { userId: 'u-1', role: 'manager', schoolCode: 'school-a' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data.deletedIds, ['u-ghost'])
    assert.equal(db.calls.userFindMany[0].where, undefined) // admin/manager 查全部
})

test('非 admin/manager：仅返回本人，且不查分组/主体（防枚举）', async () => {
    const db = makeDb()
    const res = await invoke(db, { userId: 'u-9', role: 'viewer', schoolCode: 'school-a' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body.data.deletedIds, [])
    assert.deepEqual(db.calls.userFindMany[0].where, { id: 'u-9' })
    assert.equal(db.calls.groupBy.length, 0)
    assert.equal(db.calls.principalFindMany.length, 0)
})

test('DB 异常：维持 400 + 错误信息（既有行为不回归）', async () => {
    const db = makeDb()
    db.user.findMany = async () => { throw new Error('连接断开') }
    const res = await invoke(db, { userId: 'su-1', role: 'admin', schoolCode: null })
    assert.equal(res.statusCode, 400)
    assert.ok(String(res.body.error).length > 0)
})
