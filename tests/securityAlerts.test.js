/**
 * @jest-environment node
 *
 * 第六轮·检查项 2 · SECURITY:* 事件告警闭环（securityAlerts.js）
 *
 * 验证"写了不再沉睡"：扫描器能发现 SystemLog 中新增的 SECURITY:* 事件并主动推送
 * （console.error 汇总 + 可选企业微信 webhook），游标推进正确、无事件时零打扰、
 * webhook 故障不影响业务也不吞事件。
 */

import { scanAndAlertSecurityEvents } from '../backend/lib/securityAlerts.js';

function makePrisma(rows) {
  return {
    systemLog: {
      findMany: jest.fn(async ({ where }) => rows.filter(
        (r) => r.message.startsWith('SECURITY:') && r.created_at > where.created_at.gt
      )),
    },
  };
}

const T0 = new Date('2026-07-29T10:00:00Z');

describe('检查项2 · SECURITY:* 事件扫描与推送', () => {
  test('有新增事件 → console.error 汇总 + webhook 推送（企业微信 text 格式）', async () => {
    const rows = [
      { message: 'SECURITY:REVOCATION_WRITE_FAILED', created_at: new Date(T0.getTime() + 1000) },
      { message: 'SECURITY:REFRESH_TOKEN_REPLAY', created_at: new Date(T0.getTime() + 2000) },
      { message: 'SECURITY:REFRESH_TOKEN_REPLAY', created_at: new Date(T0.getTime() + 3000) },
    ];
    const prisma = makePrisma(rows);
    const fetchImpl = jest.fn(async () => ({ ok: true }));
    const logger = { error: jest.fn() };
    const state = { lastScanAt: T0 };

    const result = await scanAndAlertSecurityEvents(prisma, state, {
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      fetchImpl, logger,
    });

    expect(result).toEqual({ scanned: 3, alerted: true });
    expect(logger.error).toHaveBeenCalled();
    const logText = logger.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logText).toContain('REVOCATION_WRITE_FAILED × 1');
    expect(logText).toContain('REFRESH_TOKEN_REPLAY × 2');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.msgtype).toBe('text');
    expect(body.text.content).toContain('3 条新安全事件');
  });

  test('无新增事件 → 零打扰（不打日志、不发 webhook），游标仍推进', async () => {
    const prisma = makePrisma([]);
    const fetchImpl = jest.fn();
    const logger = { error: jest.fn() };
    const state = { lastScanAt: T0 };

    const result = await scanAndAlertSecurityEvents(prisma, state, {
      webhookUrl: 'https://example.com/hook', fetchImpl, logger,
      now: () => new Date(T0.getTime() + 60_000), // 注入时钟，避免测试依赖真机时间
    });

    expect(result).toEqual({ scanned: 0, alerted: false });
    expect(logger.error).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.lastScanAt.getTime()).toBeGreaterThan(T0.getTime());
  });

  test('游标推进：第二轮扫描不重复告警第一轮的事件', async () => {
    const rows = [{ message: 'SECURITY:REVOCATION_WRITE_FAILED', created_at: new Date(T0.getTime() + 1000) }];
    const prisma = makePrisma(rows);
    const logger = { error: jest.fn() };
    const state = { lastScanAt: T0 };

    const clock = { t: T0.getTime() + 60_000 };
    const now = () => new Date(clock.t);
    const r1 = await scanAndAlertSecurityEvents(prisma, state, { webhookUrl: '', logger, now });
    expect(r1.scanned).toBe(1);
    clock.t += 60_000;
    const r2 = await scanAndAlertSecurityEvents(prisma, state, { webhookUrl: '', logger, now });
    expect(r2.scanned).toBe(0); // 游标已越过该事件
  });

  test('webhook 抛异常 → 不向上传播（业务无感），事件仍已在进程日志高声告警', async () => {
    const rows = [{ message: 'SECURITY:REFRESH_CONCURRENT_ROTATION', created_at: new Date(T0.getTime() + 1000) }];
    const prisma = makePrisma(rows);
    const fetchImpl = jest.fn(async () => { throw new Error('network down'); });
    const logger = { error: jest.fn() };
    const state = { lastScanAt: T0 };

    await expect(scanAndAlertSecurityEvents(prisma, state, {
      webhookUrl: 'https://example.com/hook', fetchImpl, logger,
    })).resolves.toEqual({ scanned: 1, alerted: true });
    // 主告警（汇总）+ webhook 失败告警 各一次
    expect(logger.error.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('未配置 webhook → 仅进程日志通道，不尝试网络请求', async () => {
    const rows = [{ message: 'SECURITY:TENANT_SCHEMA_MISMATCH', created_at: new Date(T0.getTime() + 1000) }];
    const prisma = makePrisma(rows);
    const fetchImpl = jest.fn();
    const logger = { error: jest.fn() };

    await scanAndAlertSecurityEvents(prisma, { lastScanAt: T0 }, { webhookUrl: '', fetchImpl, logger });
    expect(logger.error).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ============ 告警文案可辨识度增强（窗口A·第三步） ============
  // 目的：运维收到告警能立即区分「良性并发宽限」vs「真重放（已全量吊销）」，
  // 而非把所有 SECURITY 事件一视同仁。

  test('文案区分：REFRESH_CONCURRENT_ROTATION 标注 routine（多标签页正常行为）+ 频次异常核查提示', async () => {
    const rows = [{ message: 'SECURITY:REFRESH_CONCURRENT_ROTATION', created_at: new Date(T0.getTime() + 1000) }];
    const prisma = makePrisma(rows);
    const fetchImpl = jest.fn(async () => ({ ok: true }));
    const logger = { error: jest.fn() };

    await scanAndAlertSecurityEvents(prisma, { lastScanAt: T0 }, {
      webhookUrl: 'https://example.com/hook', fetchImpl, logger,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const content = body.text.content;
    // 良性标注：明确 routine + 多标签页 + 无需人工介入
    expect(content).toContain('routine');
    expect(content).toContain('多标签页正常刷新行为');
    expect(content).toContain('通常无需人工介入');
    // 30s 内重放攻击也会落入此类的风险提示 + 频次异常核查建议
    expect(content).toContain('频次异常升高');
    // 进程日志通道同样携带该文案
    const logText = logger.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logText).toContain('routine');
  });

  test('文案区分：REFRESH_TOKEN_REPLAY 保留高优先级措辞（真重放，已全量吊销）', async () => {
    const rows = [
      { message: 'SECURITY:REFRESH_TOKEN_REPLAY', created_at: new Date(T0.getTime() + 1000) },
      { message: 'SECURITY:REFRESH_CONCURRENT_ROTATION', created_at: new Date(T0.getTime() + 2000) },
    ];
    const prisma = makePrisma(rows);
    const fetchImpl = jest.fn(async () => ({ ok: true }));
    const logger = { error: jest.fn() };

    await scanAndAlertSecurityEvents(prisma, { lastScanAt: T0 }, {
      webhookUrl: 'https://example.com/hook', fetchImpl, logger,
    });

    const content = JSON.parse(fetchImpl.mock.calls[0][1].body).text.content;
    // 真重放：高优先级措辞 + 已触发全量吊销 + 立即核查指引
    expect(content).toContain('高优先级');
    expect(content).toContain('全量会话吊销');
    expect(content).toContain('疑似 token 泄露');
    // 两类事件同时出现时，各自携带各自的处置注释（可并排辨识）
    expect(content).toContain('REFRESH_TOKEN_REPLAY × 1');
    expect(content).toContain('REFRESH_CONCURRENT_ROTATION × 1');
    expect(content).toContain('routine');
  });
});
