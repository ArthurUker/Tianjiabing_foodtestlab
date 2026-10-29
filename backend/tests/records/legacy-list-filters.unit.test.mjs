import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordListFilters, MAX_CANTEEN_FILTER_LENGTH } from '../../lib/readContract.js';

test('列表筛选：默认降序、无食堂过滤', () => {
    assert.deepEqual(parseRecordListFilters({}), { ok: true, canteen: null, sort: 'desc' });
});

test('列表筛选：食堂去空格并接受升序', () => {
    assert.deepEqual(parseRecordListFilters({ canteen: ' 一食堂 ', sort: 'ASC' }), {
        ok: true,
        canteen: '一食堂',
        sort: 'asc',
    });
});

test('列表筛选：未知排序回退降序，避免注入任意排序表达式', () => {
    assert.deepEqual(parseRecordListFilters({ sort: 'created_at desc; drop table' }), {
        ok: true,
        canteen: null,
        sort: 'desc',
    });
});

test('列表筛选：过长的食堂值显式拒绝', () => {
    const result = parseRecordListFilters({ canteen: '食'.repeat(MAX_CANTEEN_FILTER_LENGTH + 1) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'INVALID_CANTEEN_FILTER');
});
