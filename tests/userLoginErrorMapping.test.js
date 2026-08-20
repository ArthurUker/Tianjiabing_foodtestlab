/**
 * userLoginErrorMapping.test.js — 登录失败错误映射（respondLoginError）单元测试
 *
 * 背景（2026-08-20 事故）：数据库 schema 与代码不一致时（如从旧备份恢复后缺列），
 * Prisma 抛 P2022 column/table does not exist。此前 respondLoginError 兜底返回
 * code=UNKNOWN + 「用户名或密码错误」，导致所有账号登录失败却无从排查。
 * 修复后：P2022 / "does not exist" 类结构错误必须返回 500 + code=SCHEMA_MISMATCH
 * + 明确提示「执行 npm run db:sync 修复」，不再伪装成密码错误。
 *
 * 测试方式：以 supertest + createUserRoutes + stub UserManager 直接打 /api/user/login，
 * stub 让 loginUser 抛出各种代表性错误，断言状态码与 JSON code。
 */

/** @jest-environment node */

jest.mock('../backend/lib/tenantClient.js', () => ({
  createTenantClient: (prisma) => prisma,
  isValidSchoolCode: (c) => typeof c === 'string' && /^[a-z0-9-]{1,40}$/.test(c),
  schemaNameOf: () => null,
  resolveSchemaName: () => 'public',
  assertSafeSchemaName: (n) => n,
  disconnectAllTenantClients: async () => {},
  DEFAULT_SCHEMA: 'public',
}));
jest.mock('../backend/lib/tenantProvisioner.js', () => ({
  isValidSchoolCode: (c) => typeof c === 'string' && /^[a-z0-9-]{1,40}$/.test(c),
}));

import express from 'express';
import request from 'supertest';
import { createUserRoutes } from '../backend/routes/userRoutes.js';

/** 构造一个 stub UserManager：loginUser 抛出指定错误 */
function makeUserManager(loginError) {
  return {
    forTenant: () => ({
      loginUser: jest.fn(async () => { throw loginError }),
    }),
  };
}

/** 构造一个抛特定错误的 stub UserManager 工厂 */
function makeApp(loginError) {
  const app = express();
  app.use(express.json());
  app.use('/api/user', createUserRoutes(makeUserManager(loginError)));
  return app;
}

const VALID_BODY = { username: 'renkang', password: 'anything', schoolCode: 'tjb' };

describe('respondLoginError 错误映射', () => {
  test('P2022（column does not exist）→ 500 + SCHEMA_MISMATCH，不伪装成密码错误', async () => {
    const err = new Error('Invalid `prisma.user.findUnique()` invocation:\nThe column `User.can_view_pathogen` does not exist in the current database.')
    err.code = 'P2022'
    const res = await request(makeApp(err)).post('/api/user/login').send(VALID_BODY)
    expect(res.status).toBe(500)
    expect(res.body.code).toBe('SCHEMA_MISMATCH')
    expect(res.body.error).toContain('npm run db:sync')
    expect(res.body.error).not.toContain('密码错误')
  })

  test('无 code 但消息含 table does not exist → 同样识别为 SCHEMA_MISMATCH', async () => {
    const err = new Error('The table `school_ljb.User` does not exist in the current database.')
    const res = await request(makeApp(err)).post('/api/user/login').send(VALID_BODY)
    expect(res.status).toBe(500)
    expect(res.body.code).toBe('SCHEMA_MISMATCH')
  })

  test('无 code 且消息含 relation does not exist → 识别为 SCHEMA_MISMATCH', async () => {
    const err = new Error('relation "User" does not exist')
    const res = await request(makeApp(err)).post('/api/user/login').send(VALID_BODY)
    expect(res.status).toBe(500)
    expect(res.body.code).toBe('SCHEMA_MISMATCH')
  })

  test('密码错误（PASSWORD_WRONG）→ 401 + PASSWORD_WRONG，维持原语义', async () => {
    const err = new Error('密码错误')
    err.code = 'PASSWORD_WRONG'
    err.status = 401
    const res = await request(makeApp(err)).post('/api/user/login').send(VALID_BODY)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('PASSWORD_WRONG')
    expect(res.body.error).toContain('密码错误')
  })

  test('账号锁定（ACCOUNT_LOCKED）→ 423 + ACCOUNT_LOCKED', async () => {
    const err = new Error('登录失败次数过多')
    err.code = 'ACCOUNT_LOCKED'
    err.status = 423
    const res = await request(makeApp(err)).post('/api/user/login').send(VALID_BODY)
    expect(res.status).toBe(423)
    expect(res.body.code).toBe('ACCOUNT_LOCKED')
  })

  test('用户不存在（USER_NOT_FOUND）→ 401 + USER_NOT_FOUND（防枚举文案）', async () => {
    const err = new Error('用户名或密码错误')
    err.code = 'USER_NOT_FOUND'
    err.status = 401
    const res = await request(makeApp(err)).post('/api/user/login').send(VALID_BODY)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('USER_NOT_FOUND')
  })

  test('未知内部错误（无 code）→ 401 + UNKNOWN（原兜底）', async () => {
    const err = new Error('some unexpected internal error')
    const res = await request(makeApp(err)).post('/api/user/login').send(VALID_BODY)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('UNKNOWN')
  })

  test('缺少用户名/密码 → 400 + 用户名或密码缺失', async () => {
    const app = makeApp(new Error('never reached'))
    const res = await request(app).post('/api/user/login').send({ schoolCode: 'tjb' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('缺失')
  })
})
