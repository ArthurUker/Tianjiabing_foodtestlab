// ====== 主题预设域（机械迁移自 admin-schools.html 1043-1127，仅做依赖注入，无行为变化）======
import { state, markDirty } from './customization/store.js';
import { renderPreview } from './preview.js';
import { escapeHtml } from './ui.js';

// 预设主题（定义见 js/utils/themePresets.js，UMD 挂载到 window.SchoolThemes）
const THEME_PRESETS = window.SchoolThemes.PRESETS;

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
    markDirty();
    if (rerender) renderPreview();
}

export function highlightThemePreset() {
    document.querySelectorAll('#themePresets .theme-swatch').forEach(b => {
        b.classList.toggle('selected', b.dataset.theme === state.selectedThemeId);
    });
}

// XR-04：管理后台自身应用（或还原）某校主题——与师生端同一 resolveTheme/applyTheme 实现
export function applyAdminTheme(cfg) {
    window.SchoolThemes.applyTheme(document, cfg ? window.SchoolThemes.resolveTheme(cfg) : null);
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
