// ====== 实时预览域（机械迁移自 admin-schools.html 1129-1312，仅做依赖注入，无行为变化）======
// XR-02：与师生端共用同一套 apply 实现，消除双轨漂移。
// 预览 iframe 加载真实 index.html；通过注入 <script type="module"> 在 iframe 自身的
// 模块环境中 import js/utils/schoolCustomization.js（与 iframe 内 main.js 命中同一模块缓存），
// 之后字段标签/隐藏/必填/下拉选项/自定义字段/字段排序/小标题/模块可见性全部直接调用
// 师生端函数，保证「预览所见 = 师生端实际」，此处不再重写任何 DOM 操作。
import { state } from './customization/store.js';
import { escapeHtml } from './ui.js';
import { MODULE_REGISTRY, getAllModules } from '/js/modules/registry.js';

let previewIframe = null;
let previewReady = false;
let previewApi = null;        // iframe 内的 schoolCustomization 模块（师生端同一实现）
let previewBaseline = null;   // 预览基线快照：师生端 apply 是"一次性正向应用"语义，重放前先还原

// 可视化编辑挂钩（visualEdit.js 注册，避免 preview <-> visualEdit 循环依赖）：
//   onPreviewReadyIfToggleOn —— 预览就绪且开关已勾选时绑定编辑能力（原 1189 行）
//   reapplyAfterBaselineRestore —— 基线还原重建表单节点后重新标记可编辑元素（原 1308 行）
let veHooks = {
    onPreviewReadyIfToggleOn: () => {},
    reapplyAfterBaselineRestore: () => {},
};
export function registerVisualEditHooks(hooks) { veHooks = hooks; }

export function getPreviewIframe() { return previewIframe; }
export function isPreviewReady() { return previewReady; }

// 获取当前生效主题对象（预设优先，否则用自定义强调色派生；原 1122-1127 行）
export function getActiveTheme() {
    const preset = state.selectedThemeId ? window.SchoolThemes.getPreset(state.selectedThemeId) : null;
    if (preset) return preset;
    const accent = document.getElementById('bf_themeColor').value.trim();
    return accent ? window.SchoolThemes.themeFromAccent(accent) : null;
}

export function initPreviewIframe() {
    const previewArea = document.getElementById('previewArea');
    if (!previewArea || previewIframe) return;
    previewArea.innerHTML = `<iframe src="./index.html?preview=true" style="width:100%;height:760px;border:none;" id="previewFrame" loading="lazy"></iframe>`;
    previewIframe = document.getElementById('previewFrame');
    previewIframe.onload = () => {
        // 等待 iframe 内 JS 初始化完成后再操作 DOM
        setTimeout(async () => {
            try {
                // 防御性：注入预览模式强制启用 + 拦截所有跳转到 login.html 的尝试
                // （部分用户反馈 iframe 被误跳转到 login.html，覆盖默认 index.html 内容）
                try {
                    const w = previewIframe.contentWindow;
                    if (w) {
                        w.__PREVIEW_MODE__ = true;
                        const blocked = (url) => typeof url === 'string' && /login\.html/.test(url);
                        try {
                            const origAssign = w.location.assign.bind(w.location);
                            w.location.assign = (u) => blocked(u) ? null : origAssign(u);
                        } catch (_) { /* 静默 */ }
                        try {
                            const origReplace = w.location.replace.bind(w.location);
                            w.location.replace = (u) => blocked(u) ? null : origReplace(u);
                        } catch (_) { /* 静默 */ }
                        try {
                            const desc = Object.getOwnPropertyDescriptor(w.location, 'href');
                            Object.defineProperty(w.location, 'href', {
                                configurable: true,
                                get: () => desc && desc.get ? desc.get.call(w.location) : String(w.location),
                                set: (v) => blocked(v) ? null : (desc && desc.set ? desc.set.call(w.location, v) : origReplace(v))
                            });
                        } catch (_) { /* 静默 */ }
                    }
                } catch (e) { console.warn('⚠️ 预览防御注入失败:', e); }
                previewApi = await loadPreviewApi();
            } catch (e) {
                console.error('❌ 预览桥接加载失败（定制预览降级为仅主题/标题）:', e);
                // M4: 用户感知降级提示（避免静默失败）
                const notice = document.getElementById('notice');
                if (notice) {
                    notice.className = 'mb-4 p-3 rounded-lg text-sm bg-yellow-50 border border-yellow-200 text-yellow-800';
                    notice.innerHTML = '⚠️ 预览功能未能完全加载，当前仅显示主题与标题。请尝试刷新页面。';
                    notice.classList.remove('hidden');
                    setTimeout(() => { notice.classList.add('hidden'); }, 8000);
                }
            }
            snapshotPreviewBaseline();
            previewReady = true;
            applyPreviewConfig();
            // 若已开启可视化编辑，预览就绪后绑定编辑能力
            veHooks.onPreviewReadyIfToggleOn();
        }, 1500);
    };
}

// 在 iframe 自身模块环境里 import 师生端定制模块，拿到与 main.js 完全相同的函数实例
function loadPreviewApi() {
    return new Promise((resolve, reject) => {
        const win = previewIframe.contentWindow;
        const doc = previewIframe.contentDocument;
        if (!win || !doc) return reject(new Error('预览 iframe 不可访问'));
        if (win.__SCHOOL_CUSTOMIZATION_API__) return resolve(win.__SCHOOL_CUSTOMIZATION_API__);
        const timer = setTimeout(() => reject(new Error('预览桥接超时')), 5000);
        win.addEventListener('preview-api-ready', () => {
            clearTimeout(timer);
            resolve(win.__SCHOOL_CUSTOMIZATION_API__);
        }, { once: true });
        const s = doc.createElement('script');
        s.type = 'module';
        s.textContent = `
            import * as api from '/js/utils/schoolCustomization.js';
            window.__SCHOOL_CUSTOMIZATION_API__ = api;
            window.dispatchEvent(new Event('preview-api-ready'));
        `;
        doc.head.appendChild(s);
    });
}

// 基线快照：记录 iframe 初始（未定制）状态，供每次重放前还原，
// 使"取消隐藏/清除改名/删除自定义字段"等回退操作也能正确反映到预览
function snapshotPreviewBaseline() {
    const doc = previewIframe?.contentDocument;
    if (!doc) return;
    const forms = {};
    getAllModules().forEach((m) => {
        if (!m.formId) return;
        const f = doc.getElementById(m.formId);
        if (f) forms[m.formId] = f.cloneNode(true);
    });
    const titles = {};
    doc.querySelectorAll('[data-title-key]').forEach(el => { titles[el.dataset.titleKey] = el.textContent; });
    previewBaseline = {
        forms,
        titles,
        systemLogo: doc.getElementById('systemLogo')?.innerHTML || '<i class="fas fa-shield-alt"></i>',
    };
}

function restorePreviewBaseline() {
    const doc = previewIframe?.contentDocument;
    if (!doc || !previewBaseline) return;
    Object.entries(previewBaseline.forms).forEach(([id, pristine]) => {
        const cur = doc.getElementById(id);
        if (cur) cur.replaceWith(pristine.cloneNode(true));
    });
    Object.entries(previewBaseline.titles).forEach(([key, text]) => {
        const el = doc.querySelector(`[data-title-key="${key}"]`);
        if (el) el.textContent = text;
    });
}

// 把编辑区当前状态组装成与服务端 SchoolCustomization 相同形态的"草稿"，
// 直接喂给师生端 apply 函数（师生端 parseJSONField 对象/JSON 字符串两种形态均兼容）
function buildDraftCustomization() {
    return {
        visible_types: Array.from(document.querySelectorAll('.vis-menu-item:checked')).map(cb => cb.value).filter(c => MODULE_REGISTRY[c]),
        field_labels: state.fieldLabels,
        hidden_fields: Array.from(state.hiddenFields),
        field_rules: state.fieldRules,
        custom_fields: state.customFields,
        field_options: state.fieldOptions,
        field_order: state.fieldOrder,
        field_types: state.fieldTypes,
        theme_config: { section_titles: state.sectionTitles, systemTitle: (document.getElementById('bf_systemTitle')?.value || '').trim() },
    };
}

export function applyPreviewConfig() {
    if (!previewIframe || !previewReady) return;
    const doc = previewIframe.contentDocument;
    if (!doc) return;

    // 0. 还原基线后再正向应用（师生端函数按"页面加载时应用一次"设计）
    restorePreviewBaseline();

    // 1. 品牌（标题/校徽）：与师生端 applySchoolBranding 作用于相同元素
    //    （#systemTitle / #systemLogo）。草稿未保存、无法走其服务端拉取路径，
    //    故此处做同构的最小赋值，不涉及字段/表单等易漂移逻辑。
    const schoolName = (document.getElementById('bf_name').value.trim() || '示例学校');
    const customTitle = (document.getElementById('bf_systemTitle')?.value || '').trim();
    const titleEl = doc.getElementById('systemTitle');
    if (titleEl) titleEl.textContent = customTitle || `${schoolName}食品安全检验管理系统`;
    const logoEl = doc.getElementById('systemLogo');
    if (logoEl) {
        const logoUrl = document.getElementById('bf_logoUrl').value.trim();
        logoEl.innerHTML = logoUrl
            ? `<img src="${escapeHtml(logoUrl)}" alt="校徽" style="width:28px;height:28px;object-fit:contain;border-radius:4px">`
            : previewBaseline?.systemLogo || '<i class="fas fa-shield-alt"></i>';
    }

    // 2. 主题：与 index/login 同一实现（themePresets.js applyTheme 覆盖 CSS 变量）
    const theme = getActiveTheme();
    window.SchoolThemes.applyTheme(doc, theme);
    // XR-04：管理后台自身同步呈现该校主题（联动编辑中的主题选择）
    window.SchoolThemes.applyTheme(document, theme);

    // 3. 核心：直接调用师生端同一套 apply 函数（iframe 模块实例，作用于 iframe 文档）
    if (previewApi) {
        const draft = buildDraftCustomization();
        try {
            previewApi.applyVisibleTypesToNav(draft);          // 模块可见性（导航 + 内容区）
            previewApi.applyCustomizationToAllForms(draft);    // 标签/隐藏/必填/选项/自定义字段/排序
            previewApi.applySchoolCustomizationToTitles(draft);// 看板卡片 / 模块小标题
        } catch (e) {
            console.error('❌ 预览应用定制失败:', e);
        }
    }

    // 4. 基线还原会重建表单节点，可视化编辑开启时需重新标记可编辑元素
    veHooks.reapplyAfterBaselineRestore();
}

// 兼容旧调用名
export const renderPreview = applyPreviewConfig;
