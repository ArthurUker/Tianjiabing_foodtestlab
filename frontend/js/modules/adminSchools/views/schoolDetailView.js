// ====== 学校详情面板（机械迁移自 admin-schools.html 1336-1374 + 2148-2532，仅做依赖注入，无行为变化）======
// 含：打开/离开详情、基本信息表单、Logo 一键上传、校徽排版编辑器、食堂编辑、Tab 切换与二级子视图路由。
// loginStyleDesigner / backupManager 由装配层注入（其初始化依赖页面认证上下文）。
import { state, markDirty } from '../customization/store.js';
import { escapeHtml, showNotice } from '../ui.js';
import { adminFetch } from '../context.js';
import { applyAdminTheme, highlightThemePreset, initThemePresets } from '../adminTheme.js';
import { initPreviewIframe, renderPreview } from '../preview.js';
import { loadCustomization } from '../customization/loadSave.js';
import { loadUsers } from './schoolUsersView.js';
import { schoolLoginUrl, loadSchools, loadRecycleBin } from './schoolsListView.js';
import { mountBadgeEditor, openBadgeEditor } from '/js/utils/schoolCustomization/badgeEditor.js';
import { setSchoolInfo, notifySchoolInfoChanged } from '/js/utils/schoolCustomization.js';

let loginStyleDesigner = null;
let backupManager = null;

export function initSchoolDetailView({ loginStyleDesigner: lsd, backupManager: bm }) {
    loginStyleDesigner = lsd;
    backupManager = bm;
    return { openDetail, switchSchoolsSubview, renderCanteenInputs, updateBadgeStyleHint };
}

export async function openDetail(code) {
    // 从当前学校切换到另一所学校前，若存在未保存修改，先确认（用户取消则中止）
    const detailPanelEl = document.getElementById('detailPanel');
    if (detailPanelEl && !detailPanelEl.classList.contains('hidden') && state.currentSchoolCode && state.currentSchoolCode !== code) {
        if (!leaveDetail()) return;
    }

    state.currentSchoolCode = code;
    const school = state.allSchools.find(s => s.code === code);
    if (!school) return;

    // 联动左侧二级菜单：显示「当前学校」配置分组并填入学校代码
    const grp = document.getElementById('sidebarSchoolConfigGroup');
    const codeLabel = document.getElementById('sidebarSchoolConfigCode');
    if (grp) grp.classList.remove('hidden');
    if (codeLabel) codeLabel.textContent = code;

    document.getElementById('detailPanel').classList.remove('hidden');
    document.getElementById('detailTitle').textContent = `${school.name || school.code} (${code})`;
    document.getElementById('detailPanel').scrollIntoView({ behavior: 'smooth' });

    // 填充基本信息
    document.getElementById('bf_code').value = school.code;
    document.getElementById('bf_loginUrl').value = schoolLoginUrl(school.code);
    document.getElementById('bf_name').value = school.name || '';
    document.getElementById('bf_shortName').value = school.short_name || '';
    document.getElementById('bf_themeColor').value = school.theme_color || '#1a73e8';
    document.getElementById('bf_themeColorPicker').value = school.theme_color || '#1a73e8';
    document.getElementById('bf_logoUrl').value = school.logo_url || '';
    document.getElementById('bf_status').value = school.status || 'active';
    updateLogoPreview(school.logo_url);

    // XR-04：进入某校配置页时，管理后台自身应用该校主题色
    // （先用基本信息的 theme_color 兜底；打开「界面定制」后 loadCustomization 会用完整 theme_config 精确化）
    // 顶部 logo 保持平台统一盾牌，不显示该校校徽（避免超管误读为该校页面）
    applyAdminTheme({ themeColor: school.theme_color });

    // 切到基本信息 Tab（经 switchSchoolsSubview 同步左侧二级菜单与主区显隐）
    state.customDirty = false; state.logoStyle = null; state.logoStyleDirty = false;  // 切换学校时重置，避免沿用上校的未保存编辑
    await loadCustomization();   // 预载 theme_config（含 logo_style），使基本信息页「校徽排版」可用
    switchSchoolsSubview('basic');
}

function updateLogoPreview(url) {
    const preview = document.getElementById('bf_logoPreview');
    if (url) {
        preview.innerHTML = `<img src="${escapeHtml(url)}" alt="logo" class="w-full h-full object-contain rounded">`;
    } else {
        preview.innerHTML = '<i class="fas fa-image text-gray-400 text-sm"></i>';
    }
}

// 校徽排版状态提示（已设置 / 未设置）
function updateBadgeStyleHint() {
    const hint = document.getElementById('bf_badgeStyleHint');
    if (!hint) return
    if (state.logoStyle && state.logoStyle.croppedUrl) {
        const mode = state.logoStyle.display === 'background' ? '背景水印' : '小徽章'
        hint.innerHTML = `<i class="fas fa-check-circle text-green-500"></i> 已设置（${mode}）`;
    } else {
        hint.textContent = '未设置排版，将使用默认小徽章';
    }
}

// 校徽排版编辑器入口：内嵌「顶部栏预览编辑模式」+ 弹窗版
const badgeEditorBtn = document.getElementById('bf_badgeEditorBtn');
const badgeEditorModalBtn = document.getElementById('bf_badgeEditorModalBtn');
const inlineMount = document.getElementById('bf_badgeEditorInline');
let inlineInstance = null;   // 当前已挂载的内嵌编辑器实例
let inlineOpen = false;

function getLogoUrl() { return (document.getElementById('bf_logoUrl')?.value || '').trim() }

// ===== 学校食堂信息管理 =====
function renderCanteenInputs(arr) {
    const list = document.getElementById('canteenList');
    if (!list) return;
    const items = Array.isArray(arr) ? arr : [];
    if (!items.length) {
        list.innerHTML = '<span class="text-xs text-gray-400 italic px-1">暂无食堂，请添加（或留空保存以使用默认 一食堂/二食堂/三食堂）</span>';
        return;
    }
    list.innerHTML = items.map((name, idx) => `
        <div class="flex items-center gap-2" data-canteen-row>
            <i class="fas fa-utensils text-gray-400 text-xs shrink-0"></i>
            <input type="text" value="${escapeHtml(name)}" placeholder="食堂名称（如：一食堂）" class="canteen-input flex-1 px-2 py-1.5 border border-gray-300 rounded-lg text-sm" data-canteen-idx="${idx}">
            <button type="button" class="canteen-del text-red-400 hover:text-red-600 px-1.5 text-sm" title="删除该食堂"><i class="fas fa-trash"></i></button>
        </div>`).join('');
    // 绑定删除事件
    list.querySelectorAll('.canteen-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const values = getCanteenValues();
            const row = btn.closest('[data-canteen-row]');
            const idx = Array.from(list.children).indexOf(row);
            if (idx >= 0) values.splice(idx, 1);
            renderCanteenInputs(values);
            markDirty();
        });
    });
}
function getCanteenValues() {
    const list = document.getElementById('canteenList');
    if (!list) return [];
    return Array.from(list.querySelectorAll('.canteen-input'))
        .map(i => i.value.trim())
        .filter(Boolean);
}
function initCanteenEditor() {
    const addBtn = document.getElementById('addCanteenBtn');
    if (!addBtn) return;
    addBtn.addEventListener('click', () => {
        const values = getCanteenValues();
        values.push('');
        renderCanteenInputs(values);
        // 聚焦最后一个输入框
        const inputs = document.getElementById('canteenList').querySelectorAll('.canteen-input');
        if (inputs.length) inputs[inputs.length - 1].focus();
        markDirty();
    });
    // 输入变化标脏（删除按钮已单独处理）
    document.getElementById('canteenList')?.addEventListener('input', () => markDirty());
}
initCanteenEditor();

function schoolNameVal() { return (document.getElementById('bf_name').value || '').trim() || '示例学校' }

function mountInlineEditor() {
    const url = getLogoUrl();
    if (!url) {
        showNotice('请先上传或填写校徽图片（建议上传本地图片以获得完整裁切能力）', 'error');
        return false;
    }
    if (inlineInstance) return true;
    inlineInstance = mountBadgeEditor(inlineMount, {
        logoUrl: url,
        logoStyle: state.logoStyle || undefined,
        schoolName: schoolNameVal(),
        customTitle: (document.getElementById('bf_systemTitle')?.value || '').trim(),
        embedded: true,
        onSave: (newStyle) => {
            state.logoStyle = newStyle;
            state.logoStyleDirty = true;
            updateBadgeStyleHint();
            showNotice('✅ 校徽排版已应用，点「保存修改」后对该校生效', 'success');
        },
    });
    return !!inlineInstance;
}

function unmountInlineEditor() {
    if (inlineInstance && inlineInstance.destroy) inlineInstance.destroy();
    inlineInstance = null;
    inlineOpen = false;
    inlineMount.classList.add('hidden');
    badgeEditorBtn.classList.remove('bg-purple-600', 'text-white');
    badgeEditorBtn.classList.add('bg-purple-50', 'text-purple-700');
}

// 切换内嵌编辑模式（展开/收起）
if (badgeEditorBtn) badgeEditorBtn.addEventListener('click', () => {
    if (inlineOpen) { unmountInlineEditor(); return; }
    if (mountInlineEditor()) {
        inlineOpen = true;
        inlineMount.classList.remove('hidden');
        badgeEditorBtn.classList.add('bg-purple-600', 'text-white');
        badgeEditorBtn.classList.remove('bg-purple-50', 'text-purple-700');
    }
});

// 弹窗版（保留原交互）
if (badgeEditorModalBtn) badgeEditorModalBtn.addEventListener('click', () => {
    const url = getLogoUrl();
    if (!url) {
        showNotice('请先上传或填写校徽图片（建议上传本地图片以获得完整裁切能力）', 'error');
        return;
    }
    openBadgeEditor({
        logoUrl: url,
        logoStyle: state.logoStyle || undefined,
        schoolName: schoolNameVal(),
        customTitle: (document.getElementById('bf_systemTitle')?.value || '').trim(),
        onSave: (newStyle) => {
            state.logoStyle = newStyle;
            state.logoStyleDirty = true;
            updateBadgeStyleHint();
            showNotice('✅ 校徽排版已更新，点「保存修改」后对该校生效', 'success');
        },
    });
});

// 校徽地址或主题色变更时，若内嵌编辑器已展开则同步重渲染（避免源图/配色不一致）
['bf_logoUrl', 'bf_themeColor'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
        if (inlineOpen) { unmountInlineEditor(); mountInlineEditor(); inlineOpen = true; inlineMount.classList.remove('hidden'); badgeEditorBtn.classList.add('bg-purple-600', 'text-white'); badgeEditorBtn.classList.remove('bg-purple-50', 'text-purple-700'); }
    });
});

// Tab 切换（由左侧二级菜单 + 详情面板「返回列表」驱动，原 .tab-btn 已移除）
let currentDetailTab = 'basic';

function switchTab(tab) {
    // 离开「界面定制」时若有未保存修改，提醒用户
    const fromTab = currentDetailTab;
    if (fromTab === 'custom' && tab !== 'custom' && state.customDirty) {
        if (!confirm('「界面定制」有未保存的修改，确定离开吗？离开后修改将丢失。')) return;
    }
    // 离开「登录样式」时若有未保存修改，提醒用户
    if (fromTab === 'login' && tab !== 'login' && loginStyleDesigner.hasUnsaved()) {
        if (!confirm('「登录样式」有未保存的修改，确定离开吗？离开后修改将丢失。')) return;
    }

    currentDetailTab = tab;

    // 左侧二级菜单激活态由 switchSchoolsSubview 统一同步（此处不处理）

    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    document.getElementById('tab-' + tab).classList.remove('hidden');

    if (tab === 'custom') {
        initThemePresets();
        initPreviewIframe();
        loadCustomization();
        // 傻瓜式：默认开启可视化编辑，并展示引导横幅
        const ve = document.getElementById('visualEditToggle');
        if (ve && localStorage.getItem('veEnabled') !== 'false') ve.checked = true;
        if (ve) ve.dispatchEvent(new Event('change'));
        const hint = document.getElementById('veHint');
        if (hint && localStorage.getItem('veHintClosed') !== '1') hint.style.display = 'flex';
    }
    if (tab === 'users') loadUsers();
    if (tab === 'login') loginStyleDesigner.load(state.currentSchoolCode);
    if (tab === 'backup') backupManager.load();
}

// ====== 学校管理二级菜单（subview）======
// 控制 schools 视图内的三类子视图：
//   list —— 工具栏 + 学校列表卡片（默认）
//   recycle —— 回收站面板
//   basic/custom/login/users/backup —— 选中学校后的 5 个 Tab（共用 detailPanel）
//
// 离开学校详情：未保存确认 + 清理状态（收起分组 / 重置选中 / 还原主题）。
// 返回 false 表示用户取消离开，调用方应中止切换并保持原详情不变。
function leaveDetail() {
    if (state.customDirty && !confirm('「界面定制」有未保存的修改，确定离开吗？修改将丢失。')) return false;
    if (loginStyleDesigner.hasUnsaved() && !confirm('「登录样式」有未保存的修改，确定离开吗？修改将丢失。')) return false;
    const grp = document.getElementById('sidebarSchoolConfigGroup');
    if (grp) grp.classList.add('hidden');
    state.currentSchoolCode = null;
    state.customDirty = false;      // 离开即丢弃未保存修改，清除脏标记
    state.logoStyle = null; state.logoStyleDirty = false;
    applyAdminTheme(null);    // 还原管理后台默认主题
    return true;
}

function switchSchoolsSubview(subName) {
    const detailSubviews = ['basic', 'custom', 'login', 'users', 'backup'];
    const isDetail = detailSubviews.includes(subName);

    const toolbar = document.getElementById('schoolsToolbar');
    const listCard = document.getElementById('schoolsListCard');
    const recyclePanel = document.getElementById('recycleBinPanel');
    const detailPanel = document.getElementById('detailPanel');

    // 从详情切到 list/recycle 时，先做未保存确认 + 清理（用户取消则保持原详情不变）
    if (!isDetail && detailPanel && !detailPanel.classList.contains('hidden')) {
        if (!leaveDetail()) return;
    }

    if (toolbar) toolbar.classList.toggle('hidden', subName !== 'list');
    if (listCard) listCard.classList.toggle('hidden', subName !== 'list');

    if (recyclePanel) {
        recyclePanel.classList.toggle('hidden', subName !== 'recycle');
        if (subName === 'recycle' && typeof loadRecycleBin === 'function') loadRecycleBin();
    }

    if (detailPanel) {
        if (isDetail) {
            detailPanel.classList.remove('hidden');
            switchTab(subName);
        } else {
            detailPanel.classList.add('hidden');
        }
    }

    // 同步左侧二级菜单激活态（list / recycle / 5 个 detail 项，互斥高亮）
    document.querySelectorAll('[data-subnav="schools"] .admin-sidebar__subitem[data-subview]').forEach(s => {
        s.classList.toggle('active', s.getAttribute('data-subview') === subName);
    });
}

document.getElementById('closeDetail').addEventListener('click', () => {
    switchSchoolsSubview('list');
});

// 「返回列表」按钮（详情面板顶部）：与关闭详情等价
document.getElementById('backToSchoolsList')?.addEventListener('click', () => {
    switchSchoolsSubview('list');
});

// 主题色联动
document.getElementById('bf_themeColor').addEventListener('input', e => {
    document.getElementById('bf_themeColorPicker').value = e.target.value || '#1a73e8';
    state.selectedThemeId = null; // 手动改色 → 自定义主题
    highlightThemePreset();
});
document.getElementById('bf_themeColorPicker').addEventListener('input', e => {
    document.getElementById('bf_themeColor').value = e.target.value;
    state.selectedThemeId = null;
    highlightThemePreset();
});
document.getElementById('bf_logoUrl').addEventListener('input', e => updateLogoPreview(e.target.value));

// Logo 一键上传（自动压缩为 data URL，傻瓜式免链接）
const bfLogoFile = document.getElementById('bf_logoFile');
if (bfLogoFile) bfLogoFile.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // 收口：类型与大小校验，避免误传非图片或超大文件卡死浏览器
    if (!/^image\//.test(file.type)) {
        showNotice('请选择图片文件（png / jpg / webp 等）', 'error');
        e.target.value = '';
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        showNotice('图片过大（超过 5MB），请先压缩或换一张', 'error');
        e.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onerror = () => { showNotice('图片读取失败，请重试', 'error'); e.target.value = ''; };
    reader.onload = () => {
        const img = new Image();
        img.onerror = () => { showNotice('图片解析失败，可能已损坏，请换一张', 'error'); e.target.value = ''; };
        img.onload = () => {
            const max = 256;
            let { width, height } = img;
            if (width > height && width > max) { height = Math.round(height * max / width); width = max; }
            else if (height > max) { width = Math.round(width * max / height); height = max; }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            document.getElementById('bf_logoUrl').value = dataUrl;
            const preview = document.getElementById('bf_logoPreview');
            preview.innerHTML = `<img src="${dataUrl}" alt="校徽" style="width:100%;height:100%;object-fit:contain">`;
            renderPreview();
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
});

// 保存基本信息
document.getElementById('basicForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    // P3: 前端预校验(与后端 HEX_COLOR_RE / isSafeLogoUrl 1MB 上限一致),避免静默失败
    const themeColor = document.getElementById('bf_themeColor').value.trim();
    const logoUrl = document.getElementById('bf_logoUrl').value.trim();
    const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
    if (themeColor && !HEX_COLOR_RE.test(themeColor)) {
        return showNotice('主题色必须为 #RRGGBB 格式，如 #3498db', 'error');
    }
    if (logoUrl && logoUrl.startsWith('data:image') && logoUrl.length > 1024 * 1024) {
        return showNotice('Logo 图片过大（base64 上限约 1MB），请压缩后再试', 'error');
    }
    const btn = document.getElementById('saveBasicBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
    try {
        const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: document.getElementById('bf_name').value.trim(),
                shortName: document.getElementById('bf_shortName').value.trim(),
                themeColor,
                logoUrl,
                systemTitle: (document.getElementById('bf_systemTitle')?.value || '').trim(),
                canteens: getCanteenValues(),
                // RBAC 收敛：访客功能开关（boolean）
                guestEnabled: (document.getElementById('bf_guestEnabled')?.checked ?? false),
                ...(state.logoStyleDirty ? { logoStyle: state.logoStyle || null } : {}),
            })
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '保存失败');
        // 状态单独更新（P1-2: 与创建表单二次 PUT 相同的错误反馈模式——
        // PATCH 失败同样需检查 resp.ok，避免「信息已保存但状态未变更」被静默吞掉）
        const newStatus = document.getElementById('bf_status').value;
        const statusResp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: newStatus })
        });
        const statusJson = await statusResp.json().catch(() => ({}));
        if (!statusResp.ok) {
            throw new Error('学校信息已保存，但状态更新失败：' + (statusJson.error || statusJson.details || '未知错误'));
        }
        showNotice('✅ 学校信息已保存', 'success');
        state.logoStyleDirty = false;
        loadSchools();
        // 写入本地外观缓存并通知师生端（跨标签页 storage 事件 / 同标签页 CustomEvent），
        // 使该校用户界面无需刷新即可看到新校徽/校名/主题色；预览区也同步刷新。
        try {
            setSchoolInfo(state.currentSchoolCode, {
                name: document.getElementById('bf_name').value.trim(),
                shortName: document.getElementById('bf_shortName').value.trim(),
                logoUrl: document.getElementById('bf_logoUrl').value.trim(),
                themeColor: document.getElementById('bf_themeColor').value.trim(),
            });
            notifySchoolInfoChanged(state.currentSchoolCode);
            if (typeof renderPreview === 'function') renderPreview();
        } catch (_) { /* 非关键路径 */ }
    } catch (e) {
        showNotice('❌ ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save mr-2"></i><span>保存修改</span>';
    }
});
