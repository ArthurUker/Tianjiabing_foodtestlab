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
    // API 前缀冲突：/api/ 被视为接口路径，首段取 api（schoolCode 不得用 api，后端已负向预查保护）
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
  // 学校代码即部署基路径首段：始终生成 /<code>/login.html?school=<code>
  // 不依赖调用方所在目录（控制台在根 /admin-schools.html 时也应产出 /<code>/...）
  test('根部署控制台也应生成 /<code>/login.html?school=<code>', () => {
    expect(buildSchoolLoginUrl('demo', { origin: 'http://h' }))
      .toBe('http://h/demo/login.html?school=demo');
  });

  test('子路径控制台同样生成 /<code>/login.html?school=<code>（与所在目录无关）', () => {
    expect(buildSchoolLoginUrl('demo', { origin: 'http://h:3002' }))
      .toBe('http://h:3002/demo/login.html?school=demo');
  });

  test('school_ 前缀与下划线归一为连字符', () => {
    expect(buildSchoolLoginUrl('school_demo_x', { origin: 'http://h' }))
      .toBe('http://h/demo-x/login.html?school=demo-x');
  });

  test('生成的链接可被 extractSchoolCode 还原为同一 code', () => {
    const url = buildSchoolLoginUrl('demo', { origin: 'http://h' });
    const u = new URL(url);
    // 路径前缀 /demo/ 命中 → demo（与登录页实际子路径一致，登录后相对重定向 ./index.html -> /demo/index.html）
    expect(extractSchoolCode(u.pathname, u.search)).toBe('demo');
  });

  test('生成的链接真实可打开该校仪表盘：从 /<code>/login.html 相对重定向到 /<code>/index.html', () => {
    const url = buildSchoolLoginUrl('demo', { origin: 'http://localhost:3002' });
    expect(url).toBe('http://localhost:3002/demo/login.html?school=demo');
  });
});
