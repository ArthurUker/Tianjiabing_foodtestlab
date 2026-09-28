/**
 * @jest-environment jsdom
 *
 * P3-W5-RECORD-T01 · AUD-002 / AUD-020 单元与回归（根 Jest 面）
 *
 * ① **反转回归**（probe 契约）：`tests/idempotencyConcurrency.test.js:90-104` 是 AUD-002 的
 *    bug-exists probe，其断言「同 key 不同 body → 两条各自处理（200）」正是 RC-01 判定为
 *    fail-open 的旧语义。按 probe 契约**不修改原 probe**，在此另建反转断言：
 *    同键异载荷必须 **409 IDEMPOTENCY_KEY_REUSE_DIFFERENT_PAYLOAD**（不当新请求、也不返回旧响应）。
 * ② 作用域隔离：不同主体同 key 同 body 不互相命中；同主体重试命中缓存。
 * ③ readContract：分页解析（超限显式拒绝）/ 游标编解码 / keyset 条件 / 覆盖范围元数据。
 * ④ exportJobs：原子发布、校验和、取消不发布、超限明确失败（文件系统台账，不依赖数据库）。
 * ⑤ Storage 覆盖范围：partial 时标签必须声明「非全量」（AUD-020：本地缓存不冒充全量）。
 */
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import idempotencyMiddleware, { idempotencyScopeOf, __idempotencyInternals } from '../backend/middleware/idempotencyMiddleware.js';
import { parsePageQuery, encodeCursor, decodeCursor, cursorWhere, mergeWhere, pageMeta, windowIsComplete } from '../backend/lib/readContract.js';

let seq = 0;
const uniqueKey = () => `w5rc-${Date.now()}-${++seq}`;

function buildApp(handler, { user = { userId: 'u-1', role: 'editor', schoolCode: 'school-a' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { ...user }; next(); });
  app.post('/api/test', idempotencyMiddleware, handler);
  return app;
}

beforeEach(() => {
  seq = 0;
  __idempotencyInternals.clear();
});

describe('AUD-002 · 幂等作用域（RC-01 反转回归）', () => {
  test('反转：同键异载荷 → 409 冲突（原 probe 期望 200/两条处理；新契约明确拒绝）', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const app = buildApp(async (req, res) => { handlerCalls++; res.json({ ok: true, n: handlerCalls }); });

    const r1 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });
    const r2 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 2 });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('IDEMPOTENCY_KEY_REUSE_DIFFERENT_PAYLOAD');
    expect(handlerCalls).toBe(1); // 冲突载荷不得执行
  });

  test('不同主体同 key 同 body：互不命中（各自执行一次）', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const handler = async (req, res) => { handlerCalls++; res.json({ ok: true, n: handlerCalls }); };
    const appA = buildApp(handler, { user: { userId: 'u-A', role: 'editor', schoolCode: 'school-a' } });
    const appB = buildApp(handler, { user: { userId: 'u-B', role: 'editor', schoolCode: 'school-a' } });

    const r1 = await request(appA).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });
    const r2 = await request(appB).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(handlerCalls).toBe(2); // subject 不同 → 身份键不同
    expect(r2.body.n).toBe(2);
  });

  test('跨学校同 key 同 body：互不命中（tenant 维度隔离）', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const handler = async (req, res) => { handlerCalls++; res.json({ ok: true }); };
    const appA = buildApp(handler, { user: { userId: 'u-1', role: 'editor', schoolCode: 'school-a' } });
    const appC = buildApp(handler, { user: { userId: 'u-1', role: 'editor', schoolCode: 'school-b' } });

    await request(appA).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });
    await request(appC).post('/api/test').set('Idempotency-Key', key).send({ a: 1 });
    expect(handlerCalls).toBe(2);
  });

  test('同主体同 key 同 body：命中缓存；payload 键序不同视为同载荷（规范化）', async () => {
    const key = uniqueKey();
    let handlerCalls = 0;
    const app = buildApp(async (req, res) => { handlerCalls++; res.json({ ok: true, n: handlerCalls }); });

    const r1 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ a: 1, b: { x: 1, y: 2 } });
    const r2 = await request(app).post('/api/test').set('Idempotency-Key', key).send({ b: { y: 2, x: 1 }, a: 1 });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect(handlerCalls).toBe(1); // 键序不同但内容等价 → 同键同载荷 → 命中
  });

  test('作用域身份：tenant/subject/resource/operationId 全维度进入身份键，且不含 payload', () => {
    const base = {
      method: 'POST', baseUrl: '/api/records', route: { path: '/:tableName' }, path: '/api/records/pesticide',
      headers: { 'idempotency-key': 'k-1' }, user: { userId: 'u-1', role: 'editor', schoolCode: 'school-a' },
    };
    const id = idempotencyScopeOf(base).identity;
    expect(idempotencyScopeOf({ ...base, headers: { 'idempotency-key': 'k-2' } }).identity).not.toBe(id);
    expect(idempotencyScopeOf({ ...base, method: 'PUT' }).identity).not.toBe(id);
    expect(idempotencyScopeOf({ ...base, user: { ...base.user, schoolCode: 'school-b' } }).identity).not.toBe(id);
    expect(idempotencyScopeOf({ ...base, user: { ...base.user, userId: 'u-2' } }).identity).not.toBe(id);
    expect(idempotencyScopeOf({ ...base, route: { path: '/:tableName/bulk-upsert' } }).identity).not.toBe(id);
  });
});

describe('AUD-002 R1 · 幂等身份含规范化具体资源（R3 复审反例 2）', () => {
  const mkReq = (url, { key = 'k-1', userId = 'u-1', schoolCode = 'school-a' } = {}) => ({
    method: 'PUT',
    originalUrl: url,
    url,
    baseUrl: '/api/records',
    route: { path: '/:tableName/:id' },
    // 真实 Express 的 req.params 不含 query/hash（测试桩同样先剥离，避免桩本身引入差异）
    params: { tableName: 'oil', id: url.split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop() },
    headers: { 'idempotency-key': key },
    user: { userId, role: 'editor', schoolCode },
  });

  test('同 key 同 body 对 /oil/r1 与 /oil/r2：身份必须不同（旧实现相同 → 第二请求误命中）', () => {
    const a = idempotencyScopeOf(mkReq('/api/records/oil/r1'));
    const b = idempotencyScopeOf(mkReq('/api/records/oil/r2'));
    expect(a.identity).not.toBe(b.identity);            // 具体资源进入身份（R1 修复点）
    expect(a.resource).toContain('/api/records/oil/r1'); // 可诊断性：身份串含实参路径
    expect(b.resource).toContain('/api/records/oil/r2');
  });

  test('同目标重试：身份逐字相同（同 key 同 body 同资源 → 仍去重）', () => {
    const r1 = idempotencyScopeOf(mkReq('/api/records/oil/r1'));
    const r1again = idempotencyScopeOf(mkReq('/api/records/oil/r1'));
    expect(r1again.identity).toBe(r1.identity);
  });

  test('规范化：query/尾斜杠不改变身份；换 key/主体/租户/方法仍隔离', () => {
    const base = idempotencyScopeOf(mkReq('/api/records/oil/r1'));
    expect(idempotencyScopeOf(mkReq('/api/records/oil/r1?x=1&y=2')).identity).toBe(base.identity);
    expect(idempotencyScopeOf(mkReq('/api/records/oil/r1/')).identity).toBe(base.identity);
    expect(idempotencyScopeOf(mkReq('/api/records/oil/r1', { key: 'k-2' })).identity).not.toBe(base.identity);
    expect(idempotencyScopeOf(mkReq('/api/records/oil/r1', { userId: 'u-2' })).identity).not.toBe(base.identity);
    expect(idempotencyScopeOf(mkReq('/api/records/oil/r1', { schoolCode: 'school-b' })).identity).not.toBe(base.identity);
    expect(idempotencyScopeOf({ ...mkReq('/api/records/oil/r1'), method: 'DELETE' }).identity).not.toBe(base.identity);
  });

  test('express 端到端：两条不同具体记录都实际执行（不只比较哈希）', async () => {
    const key = uniqueKey();
    const calls = [];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { userId: 'u-1', role: 'editor', schoolCode: 'school-a' }; next(); });
    app.put('/api/records/:tableName/:id', idempotencyMiddleware, (req, res) => {
      calls.push(`${req.params.tableName}/${req.params.id}`);
      res.json({ ok: true, id: req.params.id });
    });

    const r1 = await request(app).put('/api/records/oil/r1').set('Idempotency-Key', key).send({ a: 1 });
    const r2 = await request(app).put('/api/records/oil/r2').set('Idempotency-Key', key).send({ a: 1 });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(calls).toEqual(['oil/r1', 'oil/r2']);   // 两个 handler 都运行（旧实现只有一条）
    expect(r2.body.id).toBe('r2');                 // 各自返回自己的 id

    // 同目标重试 → 去重（不新增 handler 调用）
    const again = await request(app).put('/api/records/oil/r1').set('Idempotency-Key', key).send({ a: 1 });
    expect(again.status).toBe(200);
    expect(calls).toEqual(['oil/r1', 'oil/r2']);

    // 同目标异载荷 → 409（契约不变）
    const conflict = await request(app).put('/api/records/oil/r1').set('Idempotency-Key', key).send({ a: 2 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSE_DIFFERENT_PAYLOAD');
  });
});

describe('AUD-020 · readContract（分页与覆盖范围）', () => {
  test('超限显式拒绝：limit=10000 → LIMIT_EXCEEDS_MAX（不再静默截断）', () => {
    const r = parsePageQuery({ limit: '10000' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('LIMIT_EXCEEDS_MAX');
    expect(r.extra.maxLimit).toBe(2000);
  });

  test('非法 limit/offset/cursor 明确 400', () => {
    expect(parsePageQuery({ limit: '0' }).code).toBe('INVALID_LIMIT');
    expect(parsePageQuery({ limit: 'abc' }).ok).toBe(true); // 非数字 → 用默认值（兼容旧调用）
    expect(parsePageQuery({ offset: '-5' }).code).toBe('INVALID_OFFSET');
    expect(parsePageQuery({ cursor: 'not-a-cursor' }).code).toBe('INVALID_CURSOR');
  });

  test('游标编解码往返 + keyset 条件形状（desc：严格小于上一行）', () => {
    const row = { id: 'abc', created_at: new Date('2026-09-25T01:02:03.000Z') };
    const cur = decodeCursor(encodeCursor(row));
    expect(cur.id).toBe('abc');
    expect(cur.createdAt.toISOString()).toBe('2026-09-25T01:02:03.000Z');
    expect(cursorWhere(cur)).toEqual({ OR: [{ created_at: { lt: cur.createdAt } }, { created_at: cur.createdAt, id: { lt: 'abc' } }] });
    expect(mergeWhere({ test_type: 'oil' }, cursorWhere(cur)).AND).toHaveLength(2);
  });

  test('覆盖范围元数据：offset 模式窗口完整性 + cursor 模式续页指针', () => {
    const rows = [{ id: 'r1', created_at: new Date('2026-09-25T00:00:00Z') }];
    const off = pageMeta({ rows, total: 5, limit: 1, offset: 0 });
    expect(off.hasMore).toBe(true);
    expect(off.nextCursor).toBeTruthy();
    expect(windowIsComplete(off)).toBe(false);
    const last = pageMeta({ rows, total: 1, limit: 1, offset: 0 });
    expect(last.hasMore).toBe(false);
    expect(windowIsComplete(last)).toBe(true);
    const cur = pageMeta({ rows, total: 5, limit: 1, offset: 0, cursorUsed: true });
    expect(cur.pagination).toBe('cursor');
    expect(cur.coverage.windowComplete).toBe(false);
  });
});

describe('AUD-020 · exportJobs（文件系统台账：原子发布/取消/超限）', () => {
  let jobRootDir;
  let exportJobs;

  beforeAll(() => {
    jobRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5rc-jobs-'));
    process.env.EXPORT_JOB_DIR = jobRootDir;
    process.env.EXPORT_MAX_ROWS = '2';
    process.env.EXPORT_BATCH_SIZE = '2';
  });
  afterAll(() => {
    delete process.env.EXPORT_JOB_DIR;
    delete process.env.EXPORT_MAX_ROWS;
    fs.rmSync(jobRootDir, { recursive: true, force: true });
  });

  function stubDb(rows, { failOn = null } = {}) {
    return {
      $transaction: async (fn) => fn({
        testRecord: {
          count: async () => { if (failOn === 'count') throw new Error('db down'); return rows.length; },
          findMany: async ({ where }) => {
            if (failOn === 'findMany') throw new Error('db down');
            // 简化 keyset：按 id 排序后返回全部（测试用极小数据集）
            const withCursor = where && where.AND;
            if (!withCursor) return rows.slice();
            const cur = where.AND[1].OR[0].created_at.gt;
            return rows.filter((r) => r.created_at > cur).slice();
          },
        },
      }),
    };
  }

  test('完成：expectedCount===exportedCount + 校验和 + tmp→rename 原子发布', async () => {
    exportJobs = await import('../backend/lib/exportJobs.js');
    const manifest = exportJobs.createExportJob({ tenantScope: 'school:a', subject: 'user:1', role: 'editor', filters: {} });
    const rows = [
      { id: 'r1', test_type: 'oil', created_at: new Date('2026-09-25T00:00:00Z'), result_data: { result: '合格' } },
    ];
    const done = await exportJobs.runExportJob({ db: stubDb(rows), jobId: manifest.jobId, testTypes: ['oil'], where: { test_type: 'oil' } });
    expect(done.state).toBe('completed');
    expect(done.expectedCount).toBe(1);
    expect(done.exportedCount).toBe(1);
    expect(done.idDupCount).toBe(0);
    expect(done.artifact).toBe('artifact.ndjson');
    const artifact = exportJobs.exportJobArtifactPath(manifest.jobId);
    const content = fs.readFileSync(artifact, 'utf8');
    expect(crypto.createHash('sha256').update(content).digest('hex')).toBe(done.checksum);
    // manifest 持久且为私有权限（0600）
    const mode = fs.statSync(exportJobs.manifestPathOf(manifest.jobId)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(exportJobs.publicExportJobView(done).artifactPublished).toBe(true);
  });

  test('取消：置标记后运行 → cancelled 且不发布产物', async () => {
    exportJobs = exportJobs || await import('../backend/lib/exportJobs.js');
    const manifest = exportJobs.createExportJob({ tenantScope: 'school:a', subject: 'user:1', role: 'editor', filters: {} });
    exportJobs.requestCancel(manifest.jobId);
    const out = await exportJobs.runExportJob({ db: stubDb([{ id: 'r1', test_type: 'oil', created_at: new Date(), result_data: {} }]), jobId: manifest.jobId, testTypes: ['oil'], where: { test_type: 'oil' } });
    expect(out.state).toBe('cancelled');
    expect(out.artifact).toBe(null);
    expect(fs.existsSync(exportJobs.exportJobArtifactPath(manifest.jobId))).toBe(false);
  });

  test('超限：expectedCount > MAX_EXPORT_ROWS → 明确失败且无产物', async () => {
    exportJobs = exportJobs || await import('../backend/lib/exportJobs.js');
    const manifest = exportJobs.createExportJob({ tenantScope: 'school:a', subject: 'user:1', role: 'editor', filters: {} });
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, test_type: 'oil', created_at: new Date(Date.now() + i), result_data: {} }));
    const out = await exportJobs.runExportJob({ db: stubDb(many), jobId: manifest.jobId, testTypes: ['oil'], where: { test_type: 'oil' } });
    expect(out.state).toBe('failed');
    expect(out.error.code).toBe('EXPORT_OVER_LIMIT');
    expect(fs.existsSync(exportJobs.exportJobArtifactPath(manifest.jobId))).toBe(false);
    const purged = await exportJobs.cleanupExpiredJobs({ ttlMs: -1 });
    expect(purged.removed).toBeGreaterThan(0); // TTL 清理可观测（含失败作业）
  });
});

describe('AUD-020 R1 · ExportService 渲染范围（预览/PDF 不得冒充权威全量）', () => {
  const rowsOf = (type, n) => Array.from({ length: n }, (_, i) => ({
    id: `${type}-${i}`, testDate: '2026-09-25', canteen: '一食堂', result: '合格', inspector: '测试员',
  }));
  const configFor = (types) => ({
    startDate: '2026-09-25', endDate: '2026-09-25', canteens: [], meatTypes: [], testTypes: types, title: '测试报告', notes: '',
  });

  async function makeService(type, cachedCount, expectedCount) {
    const { ExportService } = await import('../frontend/js/services/ExportService.js');
    const svc = Object.create(ExportService.prototype); // 绕过 constructor 的真实 Storage（本用例只测报告范围语义）
    svc.storage = {
      [type]: {
        getAll: () => rowsOf(type, cachedCount),
        _updateLocalCache: () => {},
        markAuthoritativeCoverage: () => {},
        getCoverage: () => ({ known: true, partial: false, complete: true }),
      },
    };
    const jobId = `exp-test-${type}-${cachedCount}`;
    svc._authoritative = {
      at: '2026-09-25T00:00:00.000Z',
      types: [type],
      results: { [type]: { success: true, count: expectedCount, expected: expectedCount, exported: expectedCount, checksum: 'a'.repeat(64), jobId } },
      jobs: [{ type, jobId, checksum: 'a'.repeat(64), expected: expectedCount, exported: expectedCount }],
      complete: true,
      failedTypes: [],
      filters: {},
    };
    return { svc, jobId };
  }

  async function render(type, cachedCount, expectedCount) {
    const { svc, jobId } = await makeService(type, cachedCount, expectedCount);
    document.body.innerHTML = '<div id="reportPreview"></div>';
    svc._doPreviewReport(configFor([type]));
    const html = document.getElementById('reportPreview').innerHTML;
    return { svc, html, jobId, lines: svc.dataScopeLines() };
  }

  // 0 / 1 / 2000：权威快照完整 **且** 渲染完整 → 允许（且仅此时允许）"权威全量"声明
  test.each([0, 1, 2000])('真实成功分支：%i 行 → 渲染完整，允许声明权威全量', async (n) => {
    const { svc, html, lines } = await render('oil', n, n);
    expect(svc._renderAudit.oil.truncated).toBe(false);
    expect(svc._renderAudit.oil.rendered).toBe(n);
    expect(svc._renderAudit.oil.expected).toBe(n);
    expect(lines.join('\n')).toContain('（权威全量）');
    expect(lines.join('\n')).not.toContain('部分数据');
    expect(html).toContain('data-w5-raw-download='); // 原始产物入口始终给出
  });

  test('2501 行（服务端成功但浏览器上限 2000）：必须声明部分数据，且任何位置不得称"权威全量"', async () => {
    const { svc, html, jobId, lines } = await render('oil', 2501, 2501);
    expect(svc._renderAudit.oil.rendered).toBe(2000);   // 真实渲染分支（未提前 return）
    expect(svc._renderAudit.oil.expected).toBe(2501);
    expect(svc._renderAudit.oil.truncated).toBe(true);
    const scope = lines.join('\n');
    expect(scope).toContain('部分数据');
    expect(scope).not.toContain('（权威全量）');         // 核心反例：不得冒充全量
    expect(html).not.toContain('（权威全量）');           // 报告全文（含汇总/PDF 源）也不得出现
    expect(html).toContain('完整原始产物');               // 完整产物下载区块在报告中
    expect(html).toContain(`data-w5-raw-download="${jobId}"`);
    expect(html).toContain('2501');                       // 权威总行数可见
    expect(svc.rawArtifacts()).toEqual([expect.objectContaining({ type: 'oil', jobId, expected: 2501, exported: 2501 })]);
  });

  test('10000+ 行（10500）：同样为部分数据 + 原始产物入口，且渲染数与权威计数分别可见', async () => {
    const { svc, html, lines } = await render('pesticide', 10500, 10500);
    expect(svc._renderAudit.pesticide.rendered).toBe(2000);
    expect(svc._renderAudit.pesticide.expected).toBe(10500);
    const scope = lines.join('\n');
    expect(scope).toContain('部分数据');
    expect(scope).not.toContain('（权威全量）');
    expect(scope).toContain('10500');
    expect(html).toContain('data-w5-raw-download=');
  });

  test('下载完整原始产物：调用作业下载端点并触发文件保存（失败路径明确返回 false）', async () => {
    const { svc, jobId } = await makeService('oil', 2501, 2501);
    svc._authToken = () => 'test-token';
    // jsdom 不实现 Blob URL / 下载导航 → 打桩（仅测试环境）
    if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = () => 'blob:w5rc-test';
    if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {};
    const clickSpy = jest.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const bodies = [];
    global.fetch = jest.fn(async (url) => {
      bodies.push(url);
      return { ok: true, status: 200, text: async () => '{"id":"x"}\n' };
    });
    const ok = await svc.downloadRawArtifact(jobId);
    expect(ok).toBe(true);
    expect(bodies[0]).toContain(`/api/records/exports/${jobId}/download`);
    expect(clickSpy).toHaveBeenCalled();

    global.fetch = jest.fn(async () => ({ ok: false, status: 403, text: async () => '' }));
    await expect(svc.downloadRawArtifact(jobId)).resolves.toBe(false); // 撤权/过期 → 明确失败，不静默
    clickSpy.mockRestore();
  });
});

describe('AUD-020 · Storage 覆盖范围（本地窗口不得冒充全量）', () => {
  test('服务端 total 大于窗口 → partial + 标签声明"非全量"；相等 → complete', async () => {
    const { StorageService } = await import('../frontend/js/core/Storage.js');
    localStorage.clear();
    sessionStorage.clear();
    const store = new StorageService('leanMeat', { apiBaseUrl: '/api/records' });
    jest.spyOn(store, '_canSyncWithServer').mockReturnValue(true);
    jest.spyOn(store, '_getHeaders').mockReturnValue({});

    const rows = [{ id: '1', data: { a: 1 } }, { id: '2', data: { a: 2 } }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: rows, total: 5000, limit: 1000, offset: 0, returned: 2, hasMore: true, pagination: 'offset' }),
    });
    await store._syncFromApi(true);
    const cov = store.getCoverage();
    expect(cov.partial).toBe(true);
    expect(cov.complete).toBe(false);
    expect(cov.label).toContain('非全量');
    expect(cov.total).toBe(5000);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: rows, total: 2, limit: 1000, offset: 0, returned: 2, hasMore: false, pagination: 'offset' }),
    });
    await store._syncFromApi(true);
    const cov2 = store.getCoverage();
    expect(cov2.partial).toBe(false);
    expect(cov2.label).toContain('一致');
  });

  // R1（AUD-020）：权威快照导出落地后，覆盖范围元数据必须按 expected/exported/行数三者一致性标记
  test('权威快照覆盖范围：三者一致 → complete；任一不一致 → 保守 partial（不得冒充全量）', async () => {
    const { StorageService } = await import('../frontend/js/core/Storage.js');
    localStorage.clear();
    const store = new StorageService('oil', { apiBaseUrl: '/api/records' });

    const consistent = store.markAuthoritativeCoverage({ rows: [{ id: '1' }, { id: '2' }], expected: 2, exported: 2, jobId: 'exp-1', checksum: 'c' });
    expect(consistent.complete).toBe(true);
    expect(consistent.source).toBe('authoritative-export');
    expect(consistent.label).toContain('权威快照');
    expect(consistent.label).toContain('一致');

    const inconsistent = store.markAuthoritativeCoverage({ rows: [{ id: '1' }], expected: 2, exported: 2, jobId: 'exp-1' });
    expect(inconsistent.partial).toBe(true);
    expect(inconsistent.label).toContain('非全量');

    const unknown = store.markAuthoritativeCoverage({ rows: [{ id: '1' }], expected: null, exported: null, jobId: 'exp-1' });
    expect(unknown.partial).toBe(true); // 计数缺失 → 不得标全量
  });
});
