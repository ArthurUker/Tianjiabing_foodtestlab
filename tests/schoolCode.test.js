/**
 * schoolCode 解析/生成单元测试（对应登录地址复核）。
 * 覆盖：路径前缀解析、查询参数兜底、路径 vs 查询优先级、大小写、特殊字符、
 * 多层基路径已知限制、API 前缀冲突、生成-解析一致性。
 */
import { extractSchoolCode, buildSchoolLoginUrl } from '../js/utils/schoolCode.js';

describe('extractSchoolCode — 解析优先级与边界', () => {
  // [pathname, search, 期望结果]
  const cases = [
    // 根部署：无路径前缀 → 回退查询；无查询 → null（不会静默给默认学校）
    ['/login.html', '', null],
    // 单层子路径（基线场景）
    ['/demo/login.html', '', 'demo'],
    // 尾斜杠差异
    ['/demo/login.html/', '', 'demo'],
    ['/demo//login.html', '', 'demo'],
    // 含连字符的学校代码
    ['/demo-2/login.html', '', 'demo-2'],
    // 路径 vs 查询冲突：路径优先
    ['/demo/login.html', '?school=other', 'demo'],
    ['/demo/login.html', '?school=demo', 'demo'],
    // 大小写：路径仅匹配小写；不带 ?school= 时回退为 null，带 ?school= 时由查询补齐
    ['/Demo/login.html', '', null],
    ['/Demo/login.html', '?school=demo', 'demo'],
    // URL 编码：浏览器已 decode 的 pathname 可正常解析；原始编码串不匹配首段
    ['/dem%6F/login.html', '', null],
    // API 前缀冲突：/api/ 被视为接口路径，首段取 "api"（schoolCode 不得用 api，后端已负向预查保护）
    ['/api/login.html', '', 'api'],
    // 已知限制：多层基路径误取首段
    ['/apps/demo/login.html', '', 'apps'],
    ['/auth/demo/login.html', '', 'auth'],
  ];

  test.each(cases)('extractSchoolCode(%s, %j) => %s', (pathname, search, expected) => {
    expect(extractSchoolCode(pathname, search)).toBe(expected);
  });
});

describe('buildSchoolLoginUrl — 生成与解析一致', () => {
  test('根部署：生成 /login.html?school=<code>', () => {
    expect(buildSchoolLoginUrl('demo', { pathname: '/admin-schools.html', origin: 'http://h' }))
      .toBe('http://h/login.html?school=demo');
  });

  test('单层子路径：生成 /demo/login.html?school=<code>', () => {
    expect(buildSchoolLoginUrl('demo', { pathname: '/demo/admin-schools.html', origin: 'http://h:3002' }))
      .toBe('http://h:3002/demo/login.html?school=demo');
  });

  test('school_ 前缀与下划线归一为连字符', () => {
    expect(buildSchoolLoginUrl('school_demo_x', { pathname: '/admin-schools.html', origin: 'http://h' }))
      .toBe('http://h/login.html?school=demo-x');
  });

  test('生成的链接可被 extractSchoolCode 还原为同一 code（单层）', () => {
    const url = buildSchoolLoginUrl('demo', { pathname: '/demo/admin-schools.html', origin: 'http://h' });
    const u = new URL(url);
    expect(extractSchoolCode(u.pathname, u.search)).toBe('demo');
  });

  test('生成-解析在路径冲突场景下以路径为准（多层已知限制）', () => {
    // 控制台挂在 /apps/demo/，生成 /apps/demo/login.html?school=demo
    const url = buildSchoolLoginUrl('demo', { pathname: '/apps/demo/admin-schools.html', origin: 'http://h' });
    const u = new URL(url);
    // 解析端按路径首段取到 apps（已知限制：多层基路径不支持）
    expect(extractSchoolCode(u.pathname, u.search)).toBe('apps');
  });
});
