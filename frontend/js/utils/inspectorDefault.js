// 检测员默认值：按「学校 + 账号」记住上一次输入，所有检测录入模块共用。
// 只存本地，不上传；换账号或换学校互不影响。
import { extractSchoolCode } from './schoolCode.js';

const SELECTOR = 'input[name="inspector"],input[name="inspector[]"]';

function scopeKey() {
    const code = (extractSchoolCode() || '').trim();
    let uid = '';
    try {
        const raw = localStorage.getItem(code ? `current_user__${code}` : 'current_user') || localStorage.getItem('current_user');
        const user = raw ? JSON.parse(raw) : null;
        uid = String(user?.id || user?.username || '');
    } catch { /* 本地存储不可用时退化为按学校记忆 */ }
    return ['inspector', code || 'default', uid || 'anon'].join('__');
}

export function rememberInspector(value) {
    const name = String(value || '').trim();
    if (!name) return;
    try { localStorage.setItem(scopeKey(), name.slice(0, 40)); } catch { /* 隐私模式下忽略 */ }
}

export function getRememberedInspector() {
    try { return String(localStorage.getItem(scopeKey()) || '').trim(); } catch { return ''; }
}

/** 把记住的检测员填进空着的输入框（不覆盖用户已输入的内容）。 */
export function applyInspectorDefaults(root = document) {
    const name = getRememberedInspector();
    if (!name || !root?.querySelectorAll) return;
    for (const input of root.querySelectorAll(SELECTOR)) {
        if (!String(input.value || '').trim()) input.value = name;
    }
}

/** 全局安装一次：记录输入、动态表单自动补默认值。 */
export function installInspectorMemory() {
    applyInspectorDefaults();
    const remember = event => {
        const target = event.target;
        if (target && typeof target.matches === 'function' && target.matches(SELECTOR)) rememberInspector(target.value);
    };
    document.addEventListener('change', remember, true);
    document.addEventListener('blur', remember, true);

    // 餐具等模块的表单是运行时插入的，节点出现后也补一次默认值。
    const observer = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!node || node.nodeType !== 1) continue;
                if (typeof node.matches === 'function' && node.matches(SELECTOR)) { applyInspectorDefaults(node.parentNode || document); return; }
                if (typeof node.querySelector === 'function' && node.querySelector(SELECTOR)) { applyInspectorDefaults(node); return; }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}
