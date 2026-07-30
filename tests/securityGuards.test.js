/**
 * 窗口3「资源访问控制与外围加固」回归测试
 *
 * 覆盖交付要求中的四类回归场景（对应 backend/lib/securityGuards.js 纯函数层，
 * 该层被 server.js 记录 CRUD 路由 / guest 读取路由 / Logo 校验 / 启动期 CORS 校验直接调用）：
 *   1. DS3-C1（方案甲）: operator A 尝试改/删 operator B 的记录 → canModifyRecord=false（路由层返回 403）
 *   2. DS3-M6: guest 读取记录时 PII 字段被脱敏（检测结果类字段保持可见）
 *   3. DS3-M4: 伪装 MIME 类型的 base64（声明 png 实为其它内容）→ isSafeLogoUrl 拒绝
 *   4. 首轮 M5: CORS_ORIGIN 含 "*" → corsConfigHasWildcard=true（server.js 启动期 process.exit(1)）
 */
import {
    canModifyRecord,
    maskGuestSensitiveFields,
    maskPiiString,
    isSafeLogoUrl,
    matchesImageMagic,
    corsConfigHasWildcard
} from '../backend/lib/securityGuards.js';

// ====== 1. DS3-C1 记录归属校验（方案甲） ======
describe('canModifyRecord — 记录归属校验（DS3-C1 方案甲）', () => {
    const operatorA = { role: 'operator', userId: 'user-a' };
    const operatorB = { role: 'operator', userId: 'user-b' };
    const manager = { role: 'manager', userId: 'user-m' };
    const admin = { role: 'admin', userId: 'user-adm' };

    test('operator 不能修改/删除他人创建的记录（→ 路由层 403）', () => {
        expect(canModifyRecord(operatorA, { created_by: 'user-b' })).toBe(false);
        expect(canModifyRecord(operatorB, { created_by: 'user-a' })).toBe(false);
    });

    test('operator 可以修改/删除自己创建的记录', () => {
        expect(canModifyRecord(operatorA, { created_by: 'user-a' })).toBe(true);
    });

    test('manager/admin 保留全校监督权限（可改任意记录）', () => {
        expect(canModifyRecord(manager, { created_by: 'user-a' })).toBe(true);
        expect(canModifyRecord(admin, { created_by: 'user-b' })).toBe(true);
        expect(canModifyRecord(manager, { created_by: null })).toBe(true);
    });

    test('存量 created_by 为空的记录：operator 一律拒绝（仅主管可操作）', () => {
        expect(canModifyRecord(operatorA, { created_by: null })).toBe(false);
        expect(canModifyRecord(operatorA, { created_by: undefined })).toBe(false);
        expect(canModifyRecord(operatorA, { created_by: '' })).toBe(false);
    });

    test('viewer/guest/未知角色即便 created_by 匹配也不因本函数放行写权限之外的角色', () => {
        // 注：写权限由 requireEditorOrAbove 前置拦截，本函数只做归属判断；
        // 此处验证非主管角色仍严格按 created_by 匹配。
        expect(canModifyRecord({ role: 'viewer', userId: 'user-a' }, { created_by: 'user-a' })).toBe(true);
        expect(canModifyRecord({ role: 'viewer', userId: 'user-a' }, { created_by: 'user-b' })).toBe(false);
    });

    test('入参缺失时安全失败', () => {
        expect(canModifyRecord(null, { created_by: 'user-a' })).toBe(false);
        expect(canModifyRecord(operatorA, null)).toBe(false);
    });
});

// ====== 2. DS3-M6 guest 响应脱敏 ======
describe('maskGuestSensitiveFields — guest 读取记录字段级脱敏（DS3-M6）', () => {
    test('手机号/电话/联系方式类字段被部分掩码', () => {
        const masked = maskGuestSensitiveFields({
            phone: '13812345678',
            contactNumber: '02212345678',
            送检人电话: '13900001111'
        });
        expect(masked.phone).toBe('138****78');
        expect(masked.phone).not.toContain('12345');
        expect(masked.contactNumber).toBe('022****78');
        expect(masked['送检人电话']).toBe('139****11');
    });

    test('人名/账号类字段（inspector/username/full_name）被掩码', () => {
        const masked = maskGuestSensitiveFields({
            inspector: '张三丰',
            created_user: { id: 'u1', username: 'operator01', full_name: '李四' }
        });
        expect(masked.inspector).toBe('张**');
        expect(masked.created_user.username).toMatch(/^o\*+$/);
        expect(masked.created_user.full_name).toBe('李*');
        expect(masked.created_user.id).toBe('u1'); // 非敏感键不动
    });

    test('检测结果类/业务字段保持可见（不误伤）', () => {
        const payload = {
            testDate: '2026-07-29',
            canteen: '第一食堂',
            sampleName: '青菜',
            result: '合格',
            pesticideValue: 0.02,
            status: 'completed'
        };
        expect(maskGuestSensitiveFields(payload)).toEqual(payload);
    });

    test('嵌套对象与数组中的 PII 同样被脱敏；Date 对象原样保留', () => {
        const d = new Date('2026-07-29T00:00:00Z');
        const masked = maskGuestSensitiveFields({
            created_at: d,
            items: [{ inspector: '王五', value: 1 }, { idCard: '110101199001011234' }]
        });
        expect(masked.created_at).toBe(d);
        expect(masked.items[0].inspector).toBe('王*');
        expect(masked.items[0].value).toBe(1);
        expect(masked.items[1].idCard).toBe('110****34');
    });

    test('maskPiiString 边界：短字符串与空串', () => {
        expect(maskPiiString('王')).toBe('*');
        expect(maskPiiString('')).toBe('');
    });
});

// ====== 3. DS3-M4 base64 魔数校验 ======
// 各类型真实文件头对应的 base64（前若干字节）
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D]).toString('base64');
const JPEG_B64 = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 0x01]).toString('base64');
const GIF_B64 = Buffer.from('GIF89a__________', 'latin1').toString('base64');
const WEBP_B64 = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64');
const HTML_B64 = Buffer.from('<script>alert(1)</script>____', 'latin1').toString('base64');

describe('isSafeLogoUrl — base64 魔数校验（DS3-M4）', () => {
    test('声明类型与真实魔数一致 → 放行', () => {
        expect(isSafeLogoUrl(`data:image/png;base64,${PNG_B64}`)).toBe(true);
        expect(isSafeLogoUrl(`data:image/jpeg;base64,${JPEG_B64}`)).toBe(true);
        expect(isSafeLogoUrl(`data:image/gif;base64,${GIF_B64}`)).toBe(true);
        expect(isSafeLogoUrl(`data:image/webp;base64,${WEBP_B64}`)).toBe(true);
    });

    test('伪装 MIME：声明 png 实为 JPEG/HTML → 拒绝（回归 DS3-M4）', () => {
        expect(isSafeLogoUrl(`data:image/png;base64,${JPEG_B64}`)).toBe(false);
        expect(isSafeLogoUrl(`data:image/png;base64,${HTML_B64}`)).toBe(false);
        expect(isSafeLogoUrl(`data:image/jpeg;base64,${PNG_B64}`)).toBe(false);
        expect(isSafeLogoUrl(`data:image/webp;base64,${GIF_B64}`)).toBe(false);
    });

    test('WebP 需同时匹配 RIFF 与 WEBP 标识', () => {
        const riffOnly = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1').toString('base64');
        expect(isSafeLogoUrl(`data:image/webp;base64,${riffOnly}`)).toBe(false);
        expect(matchesImageMagic('webp', WEBP_B64.slice(0, 32))).toBe(true);
    });

    test('载荷过短/垃圾 base64 → 拒绝', () => {
        expect(isSafeLogoUrl('data:image/png;base64,AA')).toBe(false);
        expect(isSafeLogoUrl('data:image/png;base64,')).toBe(false);
    });

    test('SVG data URI 仍被显式拒绝（DS-12 不放宽）', () => {
        const svg = Buffer.from('<svg xmlns="..."></svg>', 'latin1').toString('base64');
        expect(isSafeLogoUrl(`data:image/svg+xml;base64,${svg}`)).toBe(false);
    });

    test('javascript: 等其它协议拒绝；超长拒绝', () => {
        expect(isSafeLogoUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeLogoUrl(`https://cdn.example.com/${'a'.repeat(3000)}.png`)).toBe(false);
        expect(isSafeLogoUrl(123)).toBe(false);
    });
});

describe('isSafeLogoUrl — 外链域名白名单（DS3-M5，可选收紧）', () => {
    const KEY = 'LOGO_ALLOWED_HOSTS';
    afterEach(() => { delete process.env[KEY]; });

    test('未配置白名单：保持向后兼容放行 http(s) 外链（已知限制已在代码内记录）', () => {
        delete process.env[KEY];
        expect(isSafeLogoUrl('https://anywhere.example.net/logo.png')).toBe(true);
    });

    test('配置白名单后：仅白名单域名（含子域）放行', () => {
        process.env[KEY] = 'cdn.example.com, img.example.org';
        expect(isSafeLogoUrl('https://cdn.example.com/logo.png')).toBe(true);
        expect(isSafeLogoUrl('https://a.cdn.example.com/logo.png')).toBe(true);
        expect(isSafeLogoUrl('https://img.example.org/x.png')).toBe(true);
        expect(isSafeLogoUrl('https://evil.com/logo.png')).toBe(false);
        // 后缀伪造：evilcdn.example.com.attacker.io 不得放行
        expect(isSafeLogoUrl('https://cdn.example.com.attacker.io/logo.png')).toBe(false);
        expect(isSafeLogoUrl('https://%%%invalid-url')).toBe(false);
    });
});

// ====== 4. 首轮 M5 CORS 通配符启动校验 ======
describe('corsConfigHasWildcard — CORS_ORIGIN 通配符检测（首轮 M5）', () => {
    test('CORS_ORIGIN="*" → 检出（server.js 据此 process.exit(1) 拒绝启动）', () => {
        expect(corsConfigHasWildcard('*')).toBe(true);
    });

    test('白名单中混入通配符条目同样检出', () => {
        expect(corsConfigHasWildcard('https://a.com, *')).toBe(true);
        expect(corsConfigHasWildcard('https://*.example.com')).toBe(true);
    });

    test('显式域名白名单 → 通过', () => {
        expect(corsConfigHasWildcard('http://111.231.166.161, https://school.example.com')).toBe(false);
        expect(corsConfigHasWildcard('')).toBe(false);
        expect(corsConfigHasWildcard(undefined)).toBe(false);
    });
});
