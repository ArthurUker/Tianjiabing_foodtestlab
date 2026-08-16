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

// 已登录则直接进入控制台（或回到 redirect 指定页面）
if (authService.isAuthenticated()) {
    const u = authService.getUser();
    if (u && u.role === 'admin' && !u.schoolCode) {
        window.location.replace(redirectTarget);
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
