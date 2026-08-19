// ====== 登录页（机械迁移自 login.html 295-795 内联 module，仅做依赖注入，无行为变化）======
// 含 7 个功能域：学校主题应用 / 登录页样式 / 已登录态守卫 / Tab 切换 / 管理员表单 /
// 强制改密 / 忘记密码 / 访客登录。
//
// 迁移注记：
// 1) 原 login.html 漏声明 errorText（super-admin-login.html 第 138 行有声明），
//    导致 showError 调用时抛 ReferenceError、登录失败无提示。迁移时补齐声明（一行，零风险）。
// 2) window.__schoolIndexUrl 由 login.html 经典 script（9-15 行）同步定义，
//    module defer 执行时已就绪，可直接使用。
// 3) window.SchoolThemes 由 /js/utils/themePresets.js（UMD）挂载，module defer 执行时已就绪。
import { authService } from '/js/services/AuthService.js';
import { GuestAuthService } from '/js/services/GuestAuthService.js';
import { extractSchoolCode } from '/js/utils/schoolCode.js';

const guestAuthService = new GuestAuthService();
// [RBAC 收敛] 默认关闭访客入口；学校配置 guest_enabled=true 时由 applySchoolTheme 动态开启
let enableGuestEntry = false;

// 按学校配置显示/隐藏访客入口 Tab（RBAC 收敛：由平台超管按校配置 guest_enabled）
function applyGuestEntryVisibility(enabled) {
    enableGuestEntry = !!enabled;
    const gTab = document.getElementById('guestTabBtn');
    const gForm = document.getElementById('guestForm');
    const aTab = document.getElementById('adminTabBtn');
    const tabs = document.getElementById('loginTabs');
    if (!gTab || !gForm) return;
    if (enableGuestEntry) {
        gTab.classList.remove('hidden');
        gForm.classList.remove('hidden');
        if (aTab) { aTab.classList.add('flex-1'); aTab.classList.remove('w-full'); }
        if (tabs) tabs.classList.add('border-b');
    } else {
        gTab.classList.add('hidden');
        gForm.classList.add('hidden');
        if (aTab) { aTab.classList.remove('flex-1'); aTab.classList.add('w-full'); }
        if (tabs) tabs.classList.remove('border-b');
    }
}

// 显式错误提示（schoolCode 缺失/非法/不存在），避免静默回退到默认/第一个学校
function showSchoolError(msg) {
    const el = document.getElementById('schoolError');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

// ===== 方案A：按 URL 路径前缀识别学校，登录前完成个性化 =====
const currentSchoolCode = extractSchoolCode();
if (currentSchoolCode) {
    applySchoolTheme(currentSchoolCode);
} else {
    showSchoolError('未识别到有效的学校登录入口，请使用学校提供的专属登录链接（例如 /demo/login.html?school=xxx）。');
}

// FIX-03: 帮助中心链接按校动态构建，携带 ?school= 以便帮助页正确"返回登录"
const helpLink = document.getElementById('helpCenterLink');
if (helpLink) {
    helpLink.href = '/help.html' + (currentSchoolCode ? '?school=' + encodeURIComponent(currentSchoolCode) : '');
}

// ===== P11：账号被停用后，后端返回 401 触发统一登出并跳转 ?banned=1 =====
// 登录页展示醒目红色横幅，禁用/隐藏登录表单，避免用户反复尝试登录却无提示。
(function handleBannedParam() {
    try {
        const params = new URLSearchParams(location.search);
        if (params.get('banned') !== '1') return;

        // 注入红色横幅（置于卡片顶部）
        const card = document.querySelector('.login-container .glass') || document.querySelector('.login-container');
        if (card) {
            const banner = document.createElement('div');
            banner.id = 'bannedBanner';
            banner.style.cssText = 'background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:12px;padding:14px 16px;margin-bottom:18px;font-size:14px;line-height:1.6;display:flex;align-items:flex-start;gap:10px;';
            banner.innerHTML = '<i class="fas fa-ban" style="margin-top:2px;"></i><div><strong>账号已被停用</strong><br>您的账号已被管理员停用，暂时无法登录系统。如有疑问，请联系所在学校的学校管理员或平台超管处理。</div>';
            card.insertBefore(banner, card.firstChild);
        }

        // 禁用管理员登录表单（隐藏输入与按钮，并阻止提交）
        const adminForm = document.getElementById('loginForm');
        if (adminForm) {
            adminForm.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
            adminForm.style.opacity = '0.55';
            adminForm.style.pointerEvents = 'none';
            adminForm.addEventListener('submit', e => e.preventDefault(), true);
        }
        // 访客入口同样禁用
        const guestFormEl = document.getElementById('guestForm');
        if (guestFormEl) {
            guestFormEl.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
        }
        const guestTab = document.getElementById('guestTabBtn');
        if (guestTab) guestTab.disabled = true;
    } catch (e) { /* 横幅注入失败不应影响页面其余功能 */ }
})();

// 登录前拉取学校个性化配置（Logo / 主题色 / 名称），失败不阻断登录
async function applySchoolTheme(schoolCode) {
    try {
        const resp = await fetch(`/api/schools/${encodeURIComponent(schoolCode)}/config`);
        if (!resp.ok) {
            let msg = '学校信息获取失败，请确认登录入口是否正确';
            try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) { /* 忽略解析失败 */ }
            showSchoolError(msg);
            return;
        }
        const json = await resp.json();
        const cfg = json && json.data;
        if (!cfg) { showSchoolError('学校不存在或未激活'); return; }

        if (cfg.name) {
            document.title = `${cfg.name} - 登录`;
            const titleEl = document.getElementById('schoolTitle');
            if (titleEl) titleEl.textContent = cfg.name;
            const subEl = document.getElementById('schoolSubtitle');
            if (subEl) subEl.textContent = cfg.shortName || cfg.name;
        }
        // 缓存该校个性化配置，供主应用业务模块按字段渲染（注意：customization 字段为字符串 JSON）
        if (cfg.customization) {
            try {
                localStorage.setItem('school_customization_' + schoolCode, JSON.stringify(cfg.customization));
            } catch (e) { /* 存储不可用时忽略 */ }
        }
        // [RBAC 收敛] 按学校配置 guest_enabled 动态开关访客入口（超管按校配置）
        if (cfg.customization && typeof cfg.customization.guest_enabled === 'boolean') {
            applyGuestEntryVisibility(cfg.customization.guest_enabled);
        }
        // 同时缓存学校外观信息（name/logoUrl/themeColor），供主页顶部标题动态显示
        try {
            localStorage.setItem('school_info_' + schoolCode, JSON.stringify({
                name: cfg.name || '',
                shortName: cfg.shortName || '',
                logoUrl: cfg.logoUrl || '',
                themeColor: cfg.themeColor || '',
            }));
        } catch (e) { /* 存储不可用时忽略 */ }
        // 预设主题：覆盖 CSS 变量整体换肤（极光壁纸 + 强调色），保留玻璃质感
        const theme = window.SchoolThemes && window.SchoolThemes.resolveTheme(cfg);
        if (theme) {
            window.SchoolThemes.applyTheme(document, theme);
            const c = theme.accent;
            const icon = document.querySelector('.logo-animation i');
            if (icon) icon.style.color = c;
            const btn = document.getElementById('loginBtn');
            if (btn) btn.style.background = `linear-gradient(90deg, ${c}, ${theme.accentStrong || window.SchoolThemes.shade(c, -12)})`;
        }
        if (cfg.logoUrl) {
            const iconWrap = document.querySelector('.logo-animation');
            if (iconWrap) {
                iconWrap.innerHTML = `<img src="${cfg.logoUrl}" alt="logo" class="w-14 h-14 object-contain">`;
            }
        }
        // ===== 登录页样式（背景 / 卡片 / 品牌）=====
        // theme_config 在 customization 中可能是 JSON 字符串，需兼容解析
        let themeConfig = null
        try {
            if (cfg.customization && cfg.customization.theme_config) {
                themeConfig = typeof cfg.customization.theme_config === 'string'
                    ? JSON.parse(cfg.customization.theme_config)
                    : cfg.customization.theme_config
            }
        } catch (e) { /* 解析失败忽略 */ }
        applyLoginStyle(themeConfig && themeConfig.login, cfg)
    } catch (e) {
        // 个性化失败不应阻断登录流程
    }
}

// 应用学校登录页样式：背景（极光/纯色/图片/默认）、登录卡片（对齐/宽/圆角/阴影/毛玻璃）、品牌（显隐校徽/标题/副标题）
function applyLoginStyle(login, cfg) {
    try {
        // 清理上一次注入的自定义背景层
        const prev = document.getElementById('loginBgLayer')
        if (prev) prev.remove()
        document.body.classList.remove('login-bg-custom')

        const bg = login && login.background
        const useCustomBg = bg && (bg.type === 'solid' || bg.type === 'image')
        if (useCustomBg) {
            document.body.classList.add('login-bg-custom')
            const layer = document.createElement('div')
            layer.id = 'loginBgLayer'
            if (bg.type === 'solid') {
                layer.style.background = bg.color || '#1a73e8'
            } else if (bg.type === 'image') {
                layer.style.backgroundImage = `url("${bg.imageUrl}")`
                layer.style.setProperty('--ls-overlay', String(bg.opacity != null ? bg.opacity : 0.25))
            }
            document.body.appendChild(layer)
        }

        // 登录卡片：对齐 / 宽度 / 圆角 / 阴影 / 毛玻璃
        const card = login && login.card
        const loginCard = document.querySelector('.login-container > .glass')
        const container = document.querySelector('.login-container')
        if (card && loginCard) {
            const w = card.width || 420
            // 容器本身也需放宽（默认 max-w-md 会限制卡片宽度）
            if (container) {
                // 手机端防溢出：宽度最多占满视口（含两侧 24px 安全边距）
                const vwSafe = Math.min(w, (window.innerWidth || 375) - 24)
                container.style.width = vwSafe + 'px'
                container.style.maxWidth = vwSafe + 'px'
                container.style.marginLeft = card.align === 'left' ? '24px'
                    : card.align === 'right' ? 'auto' : 'auto'
                container.style.marginRight = card.align === 'right' ? '24px'
                    : card.align === 'left' ? 'auto' : 'auto'
                // 图形化编辑：垂直偏移（DS-LOGIN-GRAPHIC，card.top，默认 0）
                container.style.transform = (card.top ? `translateY(${card.top}px)` : '')
            }
            loginCard.style.width = '100%'
            loginCard.style.borderRadius = (card.radius != null ? card.radius : 16) + 'px'
            loginCard.style.boxShadow = card.shadow === false
                ? 'none'
                : '0 20px 60px rgba(0,0,0,0.18)'
            loginCard.style.backdropFilter = card.blur === false ? 'none' : ''
            loginCard.style.webkitBackdropFilter = card.blur === false ? 'none' : ''
        }

        // 品牌：标题 / 副标题 / 校徽显隐
        const bd = login && login.branding
        if (bd) {
            if (bd.title != null) {
                const t = document.getElementById('schoolTitle')
                if (t) t.textContent = bd.title || (cfg.name || '食品安全检验系统')
            }
            if (bd.subtitle != null) {
                const s = document.getElementById('schoolSubtitle')
                if (s) s.textContent = bd.subtitle || (cfg.shortName || cfg.name || '')
            }
            // 校徽显隐与替换：登录页可独立设置专属校徽（bd.logoUrl），否则沿用该校默认校徽（cfg.logoUrl）
            const iconWrap = document.querySelector('.logo-animation')
            if (iconWrap) {
                if (bd.showLogo === false) {
                    iconWrap.innerHTML = '<i class="fas fa-shield-alt text-4xl text-blue-600"></i>'
                } else {
                    const logo = (bd.logoUrl && bd.logoUrl.trim()) || cfg.logoUrl
                    if (logo) {
                        iconWrap.innerHTML = `<img src="${logo}" alt="logo" class="w-14 h-14 object-contain" onerror="this.outerHTML='<i class=&quot;fas fa-shield-alt text-4xl text-blue-600&quot;></i>'">`
                    } else {
                        iconWrap.innerHTML = '<i class="fas fa-shield-alt text-4xl text-blue-600"></i>'
                    }
                }
            }
        }
    } catch (e) { /* 样式应用失败不应阻断登录 */ }
}

// 颜色工具已收敛至 window.SchoolThemes.shade（L2：消除 login.html 本地 shadeColor 副本）

// 若用户已登录（含页面意外重载场景），直接跳转主界面。
// 例外：平台超管访问 /<code>/login.html 时放行（超管无学校归属，但应能自由进入各校登录页预览/测试）
// TD-TenantIsolation 防循环：本地已登录态的 schoolCode 必须与当前登录页 URL 的
// schoolCode 匹配，否则视为「残留/串租户 token」——清除并停留在登录页，
// 不能跳回主界面（否则 index.html 拦截又会踢回登录页，形成无限循环闪退）。
{
    const _pageCode = extractSchoolCode() || '';
    const _alreadyUser = authService.getUser();
    const _tokenSchool = _alreadyUser && (_alreadyUser.schoolCode || '');
    if (_pageCode && _tokenSchool && _tokenSchool !== _pageCode) {
        console.warn(`[auth] 登录页检测到 token 归属不匹配（token=${_tokenSchool}，页面=${_pageCode}），清除残留并停留在登录页`);
        authService.clearAuth();
    } else if (authService.isAuthenticated()) {
        // TD-PreviewFix: iframe 预览使用 /login.html?school=<code>（经 server.js rewrite 后无路径前缀），
        // 原判断只认 /xxx/login.html 路径前缀，导致 preview modal 中登录页被自动跳走，表现为"点击预览无反应"。
        // extractSchoolCode() 同时识别路径前缀与 ?school= 查询参数，保持一致。
        const _urlHasSchool = !!extractSchoolCode();
        if (!(_alreadyUser && _alreadyUser.role === 'admin' && !_alreadyUser.schoolCode && _urlHasSchool)) {
            window.location.replace(window.__schoolIndexUrl());
        }
    }
}

// 每次打开登录页时清除访客 session（访客为临时身份，不自动重登录）
// TD-TenantIsolation：按学校命名空间清除（与 GuestAuthService._nsKey 一致）
(function () {
    var lm = location.pathname.match(/^\/([a-z0-9-]+)\//);
    var lcode = lm ? lm[1] : (new URLSearchParams(location.search).get('school') || '');
    var gKey = lcode ? ('guest_token__' + lcode) : 'guest_token';
    var cKey = lcode ? ('current_guest__' + lcode) : 'current_guest';
    localStorage.removeItem(gKey);
    localStorage.removeItem(cKey);
})();

// ===== 管理员登录表单元素 =====
const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const loginBtnText = document.getElementById('loginBtnText');
const errorMessage = document.getElementById('errorMessage');
// FIX: 原 login.html 漏声明 errorText（super-admin-login.html 第 138 行有声明），
//      导致 showError 调用时抛 ReferenceError、登录失败无提示。迁移时补齐。
const errorText = document.getElementById('errorText');

// ===== Tab 切换逻辑 =====
const adminTabBtn = document.getElementById('adminTabBtn');
const guestTabBtn = document.getElementById('guestTabBtn');
const adminForm = document.getElementById('loginForm');
const guestForm = document.getElementById('guestForm');

// [RBAC 收敛] 初始按默认（关闭）隐藏访客 Tab；学校配置加载后由 applySchoolTheme 按 guest_enabled 更新
applyGuestEntryVisibility(enableGuestEntry);

adminTabBtn.addEventListener('click', () => {
    adminTabBtn.classList.add('border-b-2', 'border-blue-600', 'text-blue-600');
    adminTabBtn.classList.remove('border-transparent', 'text-gray-500');
    
    guestTabBtn.classList.remove('border-b-2', 'border-blue-600', 'text-blue-600');
    guestTabBtn.classList.add('border-transparent', 'text-gray-500');
    
    adminForm.classList.remove('hidden');
    guestForm.classList.add('hidden');
});

guestTabBtn.addEventListener('click', () => {
    if (!enableGuestEntry) {
        return;
    }
    guestTabBtn.classList.add('border-b-2', 'border-blue-600', 'text-blue-600');
    guestTabBtn.classList.remove('border-transparent', 'text-gray-500');
    
    adminTabBtn.classList.remove('border-b-2', 'border-blue-600', 'text-blue-600');
    adminTabBtn.classList.add('border-transparent', 'text-gray-500');
    
    guestForm.classList.remove('hidden');
    adminForm.classList.add('hidden');
});

// 密码可见性切换 (管理员登录)
const passwordToggleBtnAdmin = document.getElementById('togglePassword');
if (passwordToggleBtnAdmin) {
    passwordToggleBtnAdmin.addEventListener('click', function() {
        const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
        passwordInput.setAttribute('type', type);
        this.innerHTML = type === 'password' 
            ? '<i class="fas fa-eye"></i>' 
            : '<i class="fas fa-eye-slash"></i>';
    });
}

// P9: 移除自定义 saved_username 存储逻辑——改为浏览器原生「保存密码」机制
// (输入框已带 autocomplete="username"/"current-password",登录成功后由浏览器
//  弹出「是否保存密码」提示,密码存入浏览器加密保险库,页面 JS 读不到明文)。
// 不再从 localStorage 恢复用户名,避免多校串号与明文存储风险。

// 管理员表单提交
form.addEventListener('submit', async function(e) {
    e.preventDefault();
    
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    // 清除错误提示
    errorMessage.classList.add('hidden');

    // 表单验证
    if (!username || !password) {
        showError('用户名和密码不能为空');
        return;
    }

    // 禁用登录按钮并显示加载状态
    loginBtn.disabled = true;
    loginBtn.classList.add('btn-loading', 'opacity-70');
    loginBtnText.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>登录中...';

    try {
        // 调用 AuthService 登录（携带 schoolCode，供后端路由到对应 schema）
        // P0-1: 读取「记住我」勾选状态——true 持久化 localStorage（关浏览器重开保持登录），
        //       false 仅 sessionStorage（关闭即登出）
        const rememberMe = document.getElementById('rememberMe')?.checked ?? true;
        const result = await authService.login(username, password, currentSchoolCode, rememberMe);

        if (result.success) {
            // P9: 不再写自定义 saved_username——浏览器原生保存密码机制接管。
            // 登录表单 autocomplete 属性已就绪,浏览器自行提示「是否保存密码」。

            // IF-2/M2: 临时密码账号（管理员重置/建号初始密码）首登强制改密。
            // 后端已对非改密接口一律 403（MUST_CHANGE_PASSWORD），此处不改密无法使用系统。
            if (result.user && result.user.mustChangePassword) {
                console.log('🔐 检测到临时密码，进入强制改密流程...');
                showForceChangePassword(password);
                return;
            }

            console.log('✅ 登录成功，跳转到主界面...');
            showError('✅ 登录成功，跳转到主界面...');
            
            // 重定向到主应用
            setTimeout(() => {
                window.location.replace(window.__schoolIndexUrl());
            }, 50);
        } else {
            const errorMsg = result.message || '登录失败，请检查用户名和密码';
            console.error('❌ 登录失败:', errorMsg);
            showError(errorMsg);
            
            form.classList.add('error-shake');
            setTimeout(() => {
                form.classList.remove('error-shake');
            }, 300);
            
            // 清空密码
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (error) {
        console.error('❌ 登录错误:', error);
        const errorMsg = error.message || '网络连接失败，请稍后重试';
        showError(errorMsg);
    } finally {
        // 恢复登录按钮
        loginBtn.disabled = false;
        loginBtn.classList.remove('btn-loading', 'opacity-70');
        loginBtnText.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>登 录';
    }
});

// 显示错误信息
function showError(message) {
    errorText.textContent = message;
    errorMessage.classList.remove('hidden');
    // 自动隐藏错误提示（5秒后）
    setTimeout(() => {
        errorMessage.classList.add('hidden');
    }, 5000);
}

// IF-2/M2: 强制改密面板（临时密码首登）。改密成功前不放行进入系统；
// 用户关闭/刷新页面则登录态仍受后端 MUST_CHANGE_PASSWORD 拦截保护。
function showForceChangePassword(currentPassword) {
    const overlay = document.createElement('div');
    overlay.id = 'forceChangePwdOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
        <div style="background:#fff;border-radius:12px;max-width:400px;width:100%;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.3);">
            <h3 style="margin:0 0 6px;font-size:18px;font-weight:700;color:#111827;">
                <i class="fas fa-shield-alt" style="color:#2563eb;margin-right:8px;"></i>首次登录须修改密码
            </h3>
            <p style="margin:0 0 18px;font-size:13px;color:#6b7280;">当前为临时密码，请设置新密码后继续（至少 8 位，含字母和数字）。</p>
            <input id="fcpNew" type="password" autocomplete="new-password" placeholder="新密码"
                style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:14px;">
            <input id="fcpConfirm" type="password" autocomplete="new-password" placeholder="确认新密码"
                style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:14px;">
            <p id="fcpError" style="display:none;margin:0 0 8px;font-size:13px;color:#dc2626;"></p>
            <button id="fcpSubmit" style="width:100%;background:#2563eb;color:#fff;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;">
                确认修改并进入系统
            </button>
        </div>`;
    document.body.appendChild(overlay);

    const newInput = overlay.querySelector('#fcpNew');
    const confirmInput = overlay.querySelector('#fcpConfirm');
    const errEl = overlay.querySelector('#fcpError');
    const submitBtn = overlay.querySelector('#fcpSubmit');
    const fail = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

    submitBtn.addEventListener('click', async () => {
        errEl.style.display = 'none';
        const np = newInput.value;
        if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(np)) {
            return fail('新密码至少 8 个字符，且必须包含字母和数字');
        }
        if (np === currentPassword) {
            return fail('新密码不能与临时密码相同');
        }
        if (np !== confirmInput.value) {
            return fail('两次输入的密码不一致');
        }
        submitBtn.disabled = true;
        submitBtn.textContent = '正在修改…';
        const r = await authService.changePassword(currentPassword, np);
        if (r.success) {
            submitBtn.textContent = '✅ 修改成功，正在进入系统…';
            setTimeout(() => window.location.replace(window.__schoolIndexUrl()), 300);
        } else {
            submitBtn.disabled = false;
            submitBtn.textContent = '确认修改并进入系统';
            fail(r.message || '密码修改失败，请重试');
        }
    });
    newInput.focus();
}

// P7: 忘记密码——引导联系管理员重置(复用现有 overlay 弹窗模式,不新增服务)
const forgotPasswordLink = document.getElementById('forgotPasswordLink');
if (forgotPasswordLink) {
    forgotPasswordLink.addEventListener('click', function(e) {
        e.preventDefault();
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
        overlay.innerHTML = [
            '<div style="background:#fff;border-radius:12px;max-width:400px;width:100%;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.3);">',
            '<h3 style="margin:0 0 6px;font-size:18px;font-weight:700;color:#111827;">',
            '<i class="fas fa-key" style="color:#2563eb;margin-right:8px;"></i>忘记密码？',
            '</h3>',
            '<p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.7;">',
            '如忘记密码，请<strong>联系所在学校的学校管理员</strong>或<strong>平台超管</strong>重置密码。',
            '</p>',
            '<p style="margin:0 0 20px;font-size:13px;color:#6b7280;line-height:1.6;">',
            '管理员可在「用户管理」中为用户重置初始密码；重置后首次登录需修改密码（至少 8 位，含字母和数字）。',
            '</p>',
            '<button type="button" style="width:100%;background:#2563eb;color:#fff;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;">',
            '我知道了',
            '</button>',
            '</div>'
        ].join('');
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function(ev) {
            if (ev.target === overlay || ev.target.tagName === 'BUTTON') {
                overlay.remove();
            }
        });
    });
}

// ===== 访客登录 - 简化版 =====
const guestEnterBtn = document.getElementById('guestEnterBtn');
const guestErrorMessage = document.getElementById('guestErrorMessage');
const guestErrorText = document.getElementById('guestErrorText');
const guestEnterBtnDefaultHtml = guestEnterBtn ? guestEnterBtn.innerHTML : '';

async function enterAsGuest() {
    if (!enableGuestEntry) {
        return false;
    }
    const ok = await guestAuthService.quickAccessAsViewer();
    if (ok) {
        window.location.href = './index.html';
        return true;
    }
    showError('快速访问失败：请通过学校专属入口（如 /学校代码/login.html）访问，或稍后重试');
    return false;
}

if (guestEnterBtn) {
    guestEnterBtn.addEventListener('click', async function() {
        if (!enableGuestEntry) {
            showError('访客入口已暂时关闭，请使用管理员账号登录');
            return;
        }
        this.disabled = true;
        this.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>正在进入...';
        const success = await enterAsGuest();
        if (!success) {
            this.disabled = false;
            this.innerHTML = guestEnterBtnDefaultHtml;
        }
    });
}

// ===== P13：访客自助注册 =====
const guestRegisterTab = document.getElementById('guestRegisterTab');
const guestQuickTab = document.getElementById('guestQuickTab');
const guestRegisterPane = document.getElementById('guestRegisterPane');
const guestQuickPane = document.getElementById('guestQuickPane');
const guestRegisterBtn = document.getElementById('guestRegisterBtn');
const guestRegUsername = document.getElementById('guestRegUsername');
const guestRegPassword = document.getElementById('guestRegPassword');
const guestRegFullName = document.getElementById('guestRegFullName');
const guestRegEmail = document.getElementById('guestRegEmail');
const guestRegPathogen = document.getElementById('guestRegPathogen');

function switchGuestSubTab(toRegister) {
    if (!guestRegisterTab || !guestQuickTab || !guestRegisterPane || !guestQuickPane) return;
    guestRegisterTab.classList.toggle('text-green-600', toRegister);
    guestRegisterTab.classList.toggle('border-green-600', toRegister);
    guestRegisterTab.classList.toggle('text-gray-500', !toRegister);
    guestRegisterTab.classList.toggle('border-transparent', !toRegister);
    guestQuickTab.classList.toggle('text-gray-500', toRegister);
    guestQuickTab.classList.toggle('border-transparent', toRegister);
    guestQuickTab.classList.toggle('text-green-600', !toRegister);
    guestQuickTab.classList.toggle('border-green-600', !toRegister);
    guestRegisterPane.classList.toggle('hidden', !toRegister);
    guestQuickPane.classList.toggle('hidden', toRegister);
    if (guestErrorMessage) guestErrorMessage.classList.add('hidden');
}

if (guestRegisterTab) guestRegisterTab.addEventListener('click', () => switchGuestSubTab(true));
if (guestQuickTab) guestQuickTab.addEventListener('click', () => switchGuestSubTab(false));

if (guestRegisterBtn) {
    guestRegisterBtn.addEventListener('click', async function() {
        if (!enableGuestEntry) {
            showError('访客入口已暂时关闭，请使用管理员账号登录');
            return;
        }
        const username = (guestRegUsername?.value || '').trim();
        const password = guestRegPassword?.value || '';
        const fullName = (guestRegFullName?.value || '').trim();
        const email = (guestRegEmail?.value || '').trim();
        const requestPathogen = !!guestRegPathogen?.checked;

        if (!username || !password) {
            showError('请填写用户名和密码');
            return;
        }
        if (String(password).length < 8) {
            showError('密码至少8位');
            return;
        }
        if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
            showError('用户名格式非法（需3-32位字母、数字或下划线）');
            return;
        }

        this.disabled = true;
        const defaultHtml = this.innerHTML;
        this.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>正在注册...';
        try {
            const result = await guestAuthService.register(username, email, password, fullName, requestPathogen);
            if (!result.success) {
                showError(result.error || '注册失败');
                this.disabled = false;
                this.innerHTML = defaultHtml;
                return;
            }
            // 注册成功：进入访客仪表盘（可申请查看病原体 / 数据导出，走审批闭环）
            window.location.href = './index.html';
        } catch (err) {
            showError('注册出错：' + (err.message || '请稍后重试'));
            this.disabled = false;
            this.innerHTML = defaultHtml;
        }
    });
}
