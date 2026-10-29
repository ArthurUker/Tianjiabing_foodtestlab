// ====== 主题预设域（机械迁移自 admin-schools.html 1043-1127，仅做依赖注入，无行为变化）======
import { state, markDirty } from './customization/store.js';
import { renderPreview, getActiveTheme } from './preview.js';
import { escapeHtml } from './ui.js';

// 预设主题（定义见 js/utils/themePresets.js，UMD 挂载到 window.SchoolThemes）
const THEME_PRESETS = window.SchoolThemes.PRESETS;
const GLASS_DEFAULTS = window.SchoolThemes.GLASS_DEFAULTS;

// 初始化主题预设选择器
export function initThemePresets() {
    const container = document.getElementById('themePresets');
    container.innerHTML = THEME_PRESETS.map(t => `
        <button type="button" class="theme-swatch" data-theme="${t.id}" style="--sw-accent:${t.accent}" title="${t.name} · ${t.desc}">
            <span class="swatch-check"><i class="fas fa-check"></i></span>
            <span class="swatch-wall">
                <span class="swatch-aurora" style="background:${window.SchoolThemes.swatchBackground(t)};background-color:${t.base}"></span>
                <span class="swatch-glassbar" style="background:${t.dark}">
                    <i class="fas fa-shield-alt"></i>
                    <span class="bar-line" style="width:26%"></span>
                    <span class="bar-line" style="width:14%;opacity:.6"></span>
                </span>
                <span class="swatch-card"></span>
                <span class="swatch-accent" style="background:${t.accent}"></span>
            </span>
            <span class="swatch-meta">
                <span class="swatch-name block">${t.name}</span>
                <span class="swatch-desc block">${t.desc}</span>
            </span>
        </button>
    `).join('');
    container.querySelectorAll('.theme-swatch').forEach(btn => {
        btn.addEventListener('click', () => selectThemePreset(btn.dataset.theme, true));
    });
    initGlassControls();
}

// ====== 玻璃效果（theme_config.glass）======
// 与预设主题正交：预设决定配色/壁纸，玻璃参数决定导航与面板的通透程度。
// state.glass 为空对象表示全部跟随主题默认值。
const GLASS_FIELDS = [
    { id: 'glassNavAlpha', key: 'navAlpha', suffix: '%' },
    { id: 'glassPanelAlpha', key: 'panelAlpha', suffix: '%' },
    { id: 'glassBlur', key: 'blur', suffix: 'px' },
];

// 从主题的深色玻璃色（rgba）中取 alpha 百分比，作为“导航/菜单玻璃”的默认值
function themeNavAlphaPct(theme) {
    const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec((theme && theme.dark) || '');
    return m ? Math.round(parseFloat(m[1]) * 100) : GLASS_DEFAULTS.navAlpha;
}

/** 当前生效的玻璃参数（已保存/草稿值优先，缺省回落到主题默认） */
export function effectiveGlass() {
    const g = state.glass || {};
    return {
        navAlpha: typeof g.navAlpha === 'number' ? g.navAlpha : themeNavAlphaPct(getActiveTheme()),
        panelAlpha: typeof g.panelAlpha === 'number' ? g.panelAlpha : GLASS_DEFAULTS.panelAlpha,
        blur: typeof g.blur === 'number' ? g.blur : GLASS_DEFAULTS.blur,
    };
}

function paintGlassLabels(eff) {
    GLASS_FIELDS.forEach(f => {
        const label = document.getElementById(f.id + 'Val');
        if (label) label.textContent = eff[f.key] + f.suffix;
    });
}

/** 把当前生效值回填到三个滑块（加载配置、切换预设时调用） */
export function syncGlassControls() {
    const eff = effectiveGlass();
    GLASS_FIELDS.forEach(f => {
        const el = document.getElementById(f.id);
        if (el) el.value = String(eff[f.key]);
    });
    paintGlassLabels(eff);
}

/** 绑定滑块事件（幂等，切换 Tab 重复调用安全） */
export function initGlassControls() {
    // 先把改动落到管理端自身（预览 iframe 未就绪时 renderPreview 会直接返回，
    // 只靠它会出现"数字变了、界面没变"）；随后再驱动预览联动。
    const commitGlass = () => {
        if (window.SchoolThemes) window.SchoolThemes.applyGlass(document, state.glass);
        renderPreview();
    };
    GLASS_FIELDS.forEach(f => {
        const el = document.getElementById(f.id);
        if (!el || el.dataset.glassBound === '1') return;
        el.dataset.glassBound = '1';
        el.addEventListener('input', () => {
            state.glass = state.glass || {};
            state.glass[f.key] = Number(el.value);
            paintGlassLabels(effectiveGlass());
            markDirty();
            commitGlass();
        });
    });
    const reset = document.getElementById('glassResetBtn');
    if (reset && reset.dataset.glassBound !== '1') {
        reset.dataset.glassBound = '1';
        reset.addEventListener('click', () => {
            state.glass = {};
            syncGlassControls();
            markDirty();
            // 复位依赖"主题 → 玻璃"的先后次序：先按当前主题重设基线，再清掉玻璃覆盖
            if (window.SchoolThemes) {
                window.SchoolThemes.applyTheme(document, getActiveTheme());
            }
            commitGlass();
        });
    }
}

// 选中主题预设：同步强调色到基本信息 Tab、高亮卡片、联动预览
export function selectThemePreset(themeId, rerender) {
    const preset = window.SchoolThemes.getPreset(themeId);
    state.selectedThemeId = preset ? preset.id : null;
    if (preset) {
        document.getElementById('bf_themeColor').value = preset.accent;
        document.getElementById('bf_themeColorPicker').value = preset.accent;
    }
    highlightThemePreset();
    // 预设换了深色玻璃底色，未手动覆盖的「导航/菜单玻璃」默认值随之变化
    syncGlassControls();
    markDirty();
    if (rerender) renderPreview();
}

export function highlightThemePreset() {
    document.querySelectorAll('#themePresets .theme-swatch').forEach(b => {
        b.classList.toggle('selected', b.dataset.theme === state.selectedThemeId);
    });
}

// XR-04：管理后台自身应用（或还原）某校主题——与师生端同一 resolveTheme/applyTheme 实现
// 玻璃参数同样跟随该校配置（cfg 为 null 时还原默认）
export function applyAdminTheme(cfg) {
    window.SchoolThemes.applyTheme(document, cfg ? window.SchoolThemes.resolveTheme(cfg) : null);
    window.SchoolThemes.applyGlass(document, cfg ? window.SchoolThemes.resolveGlass(cfg) : null);
}

// XR-04：顶部导航展示该校校徽（离开配置页还原默认图标）
export function setAdminNavLogo(logoUrl) {
    const wrap = document.getElementById('adminNavLogo');
    if (!wrap) return;
    // 平台超管界面默认不显示任何学校图标；只有进入某校详情时才显示该校校徽，离开时彻底清空
    if (logoUrl) {
        wrap.innerHTML = `<img src="${escapeHtml(logoUrl)}" alt="校徽" style="width:28px;height:28px;object-fit:contain;border-radius:6px;background:rgba(255,255,255,.85);padding:2px">`;
        wrap.classList.remove('hidden');
    } else {
        wrap.innerHTML = '';
        wrap.classList.add('hidden');
    }
}
