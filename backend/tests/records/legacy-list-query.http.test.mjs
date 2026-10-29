import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { createRecordRoutes } from '../../routes/recordRoutes.js';

function createApp(fakeDb) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.db = fakeDb;
        req.user = { id: 'test-user', role: 'admin' };
        next();
    });
    app.use(createRecordRoutes({
        authenticateUser: (req, res, next) => next(),
        requireEditorOrAbove: (req, res, next) => next(),
        requireGuestReadOnly: (req, res, next) => next(),
        idempotencyMiddleware: (req, res, next) => next(),
    }));
    return app;
}

test('GET /api/records/pathogen 支持食堂筛选、升序与服务端总数', async () => {
    let findManyArgs = null;
    const fakeDb = {
        testRecord: {
            findMany: async (args) => {
                findManyArgs = args;
                return [{ id: 'r-1', record_code: 'RC-1', test_type: 'pathogen', sample_info: { canteen: '一食堂' }, result_data: {} }];
            },
            count: async () => 5829,
        },
    };
    const server = createApp(fakeDb).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/api/records/pathogen?limit=10&offset=20&canteen=${encodeURIComponent('一食堂')}&sort=asc`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.total, 5829);
        assert.equal(body.filters.canteen, '一食堂');
        assert.equal(body.filters.sort, 'asc');
        assert.equal(body.nextCursor, null);
        assert.equal(findManyArgs.skip, 20);
        assert.equal(findManyArgs.take, 10);
        assert.deepEqual(findManyArgs.where.sample_info, { path: ['canteen'], equals: '一食堂' });
        assert.deepEqual(findManyArgs.orderBy, [{ created_at: 'asc' }, { id: 'asc' }]);
    } finally {
        server.close();
    }
});

test('GET /api/records/pathogen 拒绝过长的食堂过滤值', async () => {
    let queried = false;
    const fakeDb = {
        testRecord: {
            findMany: async () => { queried = true; return []; },
            count: async () => 0,
        },
    };
    const server = createApp(fakeDb).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/api/records/pathogen?canteen=${encodeURIComponent('食'.repeat(101))}`);
        const body = await response.json();
        assert.equal(response.status, 400);
        assert.equal(body.code, 'INVALID_CANTEEN_FILTER');
        assert.equal(queried, false);
    } finally {
        server.close();
    }
});
