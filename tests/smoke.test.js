/**
 * P2-21 冒烟测试：验证 Jest + ESM(import/export) 兼容性
 *
 * 目的：确认 babel-jest 能正确转译项目的 ESM 源码，并可被 Jest 正常导入与执行。
 * 覆盖两个零依赖的纯函数模块：Validator（类）与 pathogenRisk（具名导出函数）。
 */

import { Validator, validator } from '../js/utils/Validator.js';
import { isPositiveResult, calculatePathogenRisk } from '../js/utils/pathogenRisk.js';

describe('Jest + ESM 兼容性冒烟测试', () => {
  test('可以通过 ESM import 加载 Validator 类与单例', () => {
    expect(typeof Validator).toBe('function');
    expect(validator).toBeInstanceOf(Validator);
  });

  test('Validator 基础校验逻辑可正常执行', () => {
    const v = new Validator();
    expect(v.validateEmail('a@b.com')).toBe(true);
    expect(v.validateEmail('not-an-email')).toBe(false);
    expect(v.hasErrors()).toBe(true);
  });

  test('Validator XSS 转义可正常执行', () => {
    const v = new Validator();
    expect(v.escapeHtml('<script>')).toBe('&lt;script&gt;');
  });
});

describe('pathogenRisk 纯函数（ESM 具名导出）', () => {
  test('isPositiveResult 正确识别阳性标记', () => {
    expect(isPositiveResult('阳性')).toBe(true);
    expect(isPositiveResult('+')).toBe(true);
    expect(isPositiveResult('阴性')).toBe(false);
    expect(isPositiveResult('')).toBe(false);
  });

  test('全阴性时返回“无风险”', () => {
    const r = calculatePathogenRisk([], []);
    expect(r.riskLevel).toBe('无风险');
    expect(r.minCt).toBeNull();
  });

  test('低 Ct 阳性判定为高风险', () => {
    const r = calculatePathogenRisk([{ pathogen: '沙门氏菌', ct: 15 }]);
    expect(r.riskLevel).toBe('高风险');
    expect(r.minCt).toBe(15);
  });
});
