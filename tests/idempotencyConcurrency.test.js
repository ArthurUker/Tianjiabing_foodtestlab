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

  test('同 key 不同 body：body 哈希不同，不共享缓存', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const app = buildApp(async (req, res) => {
      handlerCalls++;
      res.json({ ok: true, n: handlerCalls });
    });

    const r1 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });
    const r2 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 2 });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(handlerCalls).toBe(2); // 不同 body → 不同 cacheKey → 各自处理
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
