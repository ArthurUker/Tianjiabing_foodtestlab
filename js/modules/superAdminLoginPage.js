// ====== 平台超管登录页（机械迁移自 super-admin-login.html 114-278 内联 module，无行为变化）======
// 含：redirect 防开放重定向校验、已登录态守卫、登录表单、密码可见性、
//     "我是学校管理员"学校代码校验与跳转。
import { authService } from '/js/services/AuthService.js';

// 解析并校验 redirect 参数（防开放重定向：仅允许站内相对路径）。
// 汇总报告页（docs/test-results/latest/index.html）在 token 失效时
// redirectToLogin() 会携带 ?redirect=<原页面>，登录成功后应回到原页面，
// 而不是固定跳回 admin-schools.html（否则会表现为「闪退回超管界面」）。
function resolveRedirect() {
    try {
        const raw = new URLSearchParams(window.location.search).get('redirect');
        if (raw && /^\/[^/]/.test(raw) && !/^\/\//.test(raw) && !/[:\\]/.test(raw)) {
            return raw;
        }
    } catch (e) { /* 忽略非法参数 */ }
    return './admin-schools.html';
}
const redirectTarget = resolveRedirect();

const form = document.getElementById('saLoginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const loginBtnText = document.getElementById('loginBtnText');
const errorMessage = document.getElementById('errorMessage');
const errorText = document.getElementById('errorText');

// 已登录则直接进入控制台（或回到 redirect 指定页面）。
// 例外：如果已登录但仍处于「首次登录须改密」状态，token 对受保护接口全部 403，
// 不能直接跳到控制台（否则表现为「进入控制台但所有接口 403」）。
// 清除残留登录态，强制用户重新走登录流程：用户输入临时密码登录时，
// loginSuperAdmin 返回 mustChangePassword=true，会再次弹出强制改密弹窗。
if (authService.isAuthenticated()) {
    const u = authService.getUser();
    if (u && u.role === 'admin' && !u.schoolCode) {
        if (u.mustChangePassword) {
            console.warn('[auth] 检测到已登录但首登未改密，清除残留登录态，停留在登录页');
            authService.clearAuth();
        } else {
            window.location.replace(redirectTarget);
        }
    }
}

function showError(msg) {
    errorText.textContent = msg;
    errorMessage.classList.remove('hidden');
}
function hideError() {
    errorMessage.classList.add('hidden');
}

// 密码可见性切换
document.getElementById('togglePassword').addEventListener('click', function () {
    const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordInput.setAttribute('type', type);
    this.innerHTML = type === 'password' ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>';
});

form.addEventListener('submit', async function (e) {
    e.preventDefault();
    hideError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
        showError('用户名和密码不能为空');
        return;
    }

    loginBtn.disabled = true;
    loginBtn.classList.add('btn-loading', 'opacity-70');
    loginBtnText.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>登录中...';

    try {
        // P0-1: 平台超管登录默认持久化（保持登录态语义）；如需"会话级"可在登录页加勾选后传入
        const result = await authService.loginSuperAdmin(username, password, true);
        if (result.success) {
            // IF-2/M2: 临时密码账号（管理员重置/建号初始密码）首登强制改密。
            // 后端已对非白名单接口一律 403（MUST_CHANGE_PASSWORD），此处不改密无法使用系统。
            // 超管登录页（与 loginPage.js 处理一致）必须在此拦截，否则直接跳到控制台后所有接口 403。
            if (result.user && result.user.mustChangePassword) {
                console.log('🔐 检测到临时密码，进入强制改密流程...');
                showForceChangePassword(username, password);
                // 登入按钮回退到初始态，避免按钮文案停留在"登录成功"造成误解
                return;
            }

            loginBtnText.innerHTML = '<i class="fas fa-check mr-2"></i>登录成功';
            setTimeout(() => window.location.replace(redirectTarget), 80);
        } else {
            showError(result.message || '登录失败，请检查账号或密码');
            form.classList.add('error-shake');
            setTimeout(() => form.classList.remove('error-shake'), 300);
            passwordInput.value = '';
        }
    } catch (err) {
        showError('网络错误，请稍后重试');
    } finally {
        loginBtn.disabled = false;
        loginBtn.classList.remove('btn-loading', 'opacity-70');
        loginBtnText.textContent = '登 录';
    }
});

// IF-2/M2: 强制改密面板（临时密码首登）。改密成功前不放行进入系统；
// 用户关闭/刷新页面则登录态仍受后端 MUST_CHANGE_PASSWORD 拦截保护。
// 与 loginPage.js 中 showForceChangePassword 行为一致；为保持两入口独立不共享实现，
// 此处内联一份以适配超管场景：改密成功后会调用 loginSuperAdmin 用新密码重新登录
// （后端 IF-1：用户自行改密后会吊销全部旧会话，需重新登录才能继续访问系统）。
function showForceChangePassword(username, currentPassword) {
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
            submitBtn.textContent = '✅ 修改成功，正在重新登录…';
            // 后端 IF-1：用户自行改密后会吊销全部旧会话（含当前会话），
            // 必须用新密码重新登录才能继续访问受保护接口。否则直接跳转会被踢回登录页。
            const reLogin = await authService.loginSuperAdmin(username, np, true);
            if (reLogin.success) {
                setTimeout(() => window.location.replace(redirectTarget), 300);
            } else {
                submitBtn.disabled = false;
                submitBtn.textContent = '确认修改并进入系统';
                fail('密码已修改，但自动重新登录失败：' + (reLogin.message || '请手动登录'));
            }
        } else {
            submitBtn.disabled = false;
            submitBtn.textContent = '确认修改并进入系统';
            fail(r.message || '密码修改失败，请重试');
        }
    });
    newInput.focus();
}

// ===== Q5: "我是学校管理员" —— 先输入学校代码,再跳转到 /<code>/login.html =====
const btnGoSchoolLogin = document.getElementById('btnGoSchoolLogin');
const schoolCodeBox = document.getElementById('schoolCodeBox');
const schoolCodeInput = document.getElementById('schoolCodeInput');
const btnGoSchool = document.getElementById('btnGoSchool');

const schoolCodeError = document.getElementById('schoolCodeError');

// FIX-04: 统一的非法输入反馈——红框(.input-error，自定义 CSS，不依赖 Tailwind 打包)
// + 内联错误文案。清除错误态统一走 clearSchoolError。
function showSchoolCodeError(msg) {
    schoolCodeInput.classList.add('input-error');
    if (schoolCodeError) {
        schoolCodeError.textContent = msg;
        schoolCodeError.classList.remove('hidden');
    }
}
function clearSchoolCodeError() {
    schoolCodeInput.classList.remove('input-error');
    if (schoolCodeError) {
        schoolCodeError.textContent = '';
        schoolCodeError.classList.add('hidden');
    }
}

// 返回 { valid, code }：非法时已设置红框+文案，合法时清除错误态
function validateSchoolCode(raw) {
    const c = (raw || '').trim().toLowerCase();
    if (!c) {
        showSchoolCodeError('请输入学校代码');
        return { valid: false, code: '' };
    }
    // Q5: 仅允许小写字母/数字/连字符(与 extractSchoolCode 正则一致),避免非法输入
    if (!/^[a-z0-9-]+$/.test(c)) {
        showSchoolCodeError('学校代码仅含小写字母、数字或连字符');
        return { valid: false, code: '' };
    }
    clearSchoolCodeError();
    return { valid: true, code: c };
}

function goToSchoolLogin(code) {
    const { valid, code: c } = validateSchoolCode(code);
    if (!valid) return;
    // 生产 Caddy 会将 /<code>/login.html rewrite 回根 /login.html(丢 schoolCode 路径前缀),
    // 因此改用 ?school=<code> 查询参数(login.html 的 extractSchoolCode 通过查询参数兜底识别学校),
    // 避免触发"未识别到有效学校入口"红字。
    window.location.replace('./login.html?school=' + encodeURIComponent(c));
}

if (btnGoSchoolLogin) {
    btnGoSchoolLogin.addEventListener('click', () => {
        schoolCodeBox.classList.toggle('hidden');
        if (!schoolCodeBox.classList.contains('hidden')) schoolCodeInput.focus();
    });
}
if (btnGoSchool) {
    btnGoSchool.addEventListener('click', () => goToSchoolLogin(schoolCodeInput.value));
}
if (schoolCodeInput) {
    schoolCodeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') goToSchoolLogin(schoolCodeInput.value);
    });
    // FIX-04: 实时校验——输入过程中即时清除/显示错误，而非仅点击/回车时反馈
    schoolCodeInput.addEventListener('input', () => {
        const raw = schoolCodeInput.value.trim();
        if (!raw) {
            clearSchoolCodeError();
            return;
        }
        const c = raw.toLowerCase();
        if (!/^[a-z0-9-]+$/.test(c)) {
            showSchoolCodeError('学校代码仅含小写字母、数字或连字符');
        } else {
            clearSchoolCodeError();
        }
    });
}
