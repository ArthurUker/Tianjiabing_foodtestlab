/**
 * @jest-environment node
 *
 * R2-07 / 架构优化计划 P0-2：
 * 幂等中间件 TOCTOU 并发回归测试。
 *
 * 背景：修复前 idempotencyMiddleware 是 check-then-act（先 get 检查、无占位直接放行），
 * 并发同 key 请求会同时通过检查、各自写库，幂等语义失效。
 * 修复后：get 通过后立即写入 pending 占位，后续同 key 请求命中 pending 返回 409。
 *
 * 注意：middleware 的 store 是模块级 Map，同一文件内跨用例共享。
 * 故每个用例使用唯一 key（uniqueKey），避免跨用例缓存污染，不依赖 resetModules。
 */

import express from 'express';
import request from 'supertest';
import idempotencyMiddleware from '../backend/middleware/idempotencyMiddleware.js';

let seq = 0;
const uniqueKey = () => `it-key-${Date.now()}-${++seq}`;

function buildApp(handler) {
  const app = express();
  app.use(express.json());
  app.post('/api/test', idempotencyMiddleware, handler);
  return app;
}

beforeEach(() => { seq = 0; });

describe('幂等中间件 · TOCTOU 并发回归', () => {
  test('并发同 key 同 body：仅 1 个进入 handler，其余 409（修复前全部进入）', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const app = buildApp(async (req, res) => {
      handlerCalls++;
      await new Promise((r) => setTimeout(r, 60)); // 模拟写库延迟，放大竞态窗口
      res.json({ ok: true, seq: handlerCalls });
    });

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1 })
      )
    );

    const ok = results.filter((r) => r.status === 200);
    const conflict = results.filter((r) => r.status === 409);

    // 修复后：恰好 1 个进入 handler 成功，其余命中 pending → 409
    expect(handlerCalls).toBe(1);
    expect(ok.length).toBe(1);
    expect(conflict.length).toBe(N - 1);
  });

  test('成功后复用缓存：同 key 同 body 二次请求命中缓存，不再进入 handler', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const app = buildApp(async (req, res) => {
      handlerCalls++;
      res.json({ ok: true, id: 'created-1' });
    });

    const r1 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });
    const r2 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body); // 命中缓存，返回同一结果
    expect(handlerCalls).toBe(1);      // 未二次进入 handler
  });

  test('失败响应删除占位：失败后同 key 可重试（不命中失败缓存）', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const app = buildApp(async (req, res) => {
      handlerCalls++;
      res.status(400).json({ error: '校验失败' });
    });

    const r1 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });
    const r2 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });

    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400); // 占位已删除，允许重试
    expect(handlerCalls).toBe(2); // 两次都进入 handler
  });

  // AUD-002 溯源（P3-W5-RECORD-T01-R1 按场景保留原则更新，2026-09-25）：
  //   本用例原断言「同 key 不同 body → 两条各自处理（200/200、handlerCalls=2）」编码的是 RC-01 判定为
  //   fail-open 的**旧语义**（同键异载荷被当成另一条新请求执行）。RC-01 / AUD-002 新契约：**同键异载荷
  //   同目标 = 明确 409 冲突**（不得执行、不得返回旧响应）。场景（同 key 异 body）保留，断言按新契约反转；
  //   独立的反转回归另见 tests/w5RecordContract.test.js 与 backend/tests/records/aud002-* 集成套件。
  test('同 key 不同 body（同目标）：新契约一律 409 冲突，不执行第二次', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const app = buildApp(async (req, res) => {
      handlerCalls++;
      res.json({ ok: true, n: handlerCalls });
    });

    const r1 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });
    const r2 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 2 });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(409); // AUD-002：同键异载荷 = 冲突（旧断言为 200）
    expect(r2.body.code).toBe('IDEMPOTENCY_KEY_REUSE_DIFFERENT_PAYLOAD');
    expect(handlerCalls).toBe(1); // 冲突载荷不得执行（旧断言为 2）
  });

  // AUD-002 R1 独立反例回归（R3 复审反例 2）：幂等身份必须含**规范化具体资源**。
  // 旧实现只用路由模板 → 同 key/body 对 /api/test/r1 与 /api/test/r2 的第二条会命中第一条缓存、
  // handler 不执行却返回第一条结果。本用例不只断言身份/哈希不同，还断言**两个 handler 都实际运行**。
  test('同 key 同 body 对两个不同具体记录：各自执行并返回各自 id；同目标重试仍去重', async () => {
    const key = uniqueKey();
    const calls = [];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { userId: 'u-1', role: 'editor', schoolCode: 'school-a' }; next(); });
    app.put('/api/test/:id', idempotencyMiddleware, (req, res) => {
      calls.push(req.params.id);
      res.json({ ok: true, id: req.params.id, call: calls.length });
    });

    const r1 = await request(app).put('/api/test/r1').set('Idempotency-Key', key).send({ a: 1 });
    const r2 = await request(app).put('/api/test/r2').set('Idempotency-Key', key).send({ a: 1 });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(calls).toEqual(['r1', 'r2']);   // 两个 handler 都实际运行（旧实现只会有 ['r1']）
    expect(r2.body.id).toBe('r2');          // 第二条返回**自己**的 id（旧实现会返回 r1）

    // 同目标重试（同 key 同 body 同路径）仍必须去重：命中缓存，不再执行 handler
    const r1again = await request(app).put('/api/test/r1').set('Idempotency-Key', key).send({ a: 1 });
    expect(r1again.status).toBe(200);
    expect(r1again.body).toEqual(r1.body);
    expect(calls).toEqual(['r1', 'r2']);    // 未新增 handler 调用
  });

  test('无 Idempotency-Key 的请求不受中间件影响', async () => {
    let handlerCalls = 0;
    const app = buildApp(async (req, res) => {
      handlerCalls++;
      res.json({ ok: true });
    });

    const r = await request(app).post('/api/test').send({ a: 1 });
    expect(r.status).toBe(200);
    expect(handlerCalls).toBe(1);
  });
});
