// ====== 快速访问（访客/只读）模式统一管理 ======
// 原 index.html 散落的 ~330 行 quickAccess 逻辑（检测 / CSS 注入 / 表格渲染 / dashboard 更新）
// 已由 main.js + Tableware.js / GenericTest.js / Dashboard.js 的内建分支处理；
// 本模块仅收敛"检测 + CSS 注入"为单一事实来源，供 main.js 复用，消除重复检测与散落 CSS 规则。
//
// FOUC 防护仍由 index.html head 内联极简同步 script 处理（module defer 执行晚于首次渲染，
// 无法在页面可见前注入 CSS，故早期防护必须用普通同步 script）。
import guestAuthService from '../services/GuestAuthService.js';

// 检测当前是否为快速访问模式（URL 参数 ?quickAccess=true 或访客已登录）
export function isQuickAccessMode() {
    const urlParam = new URLSearchParams(window.location.search).get('quickAccess') === 'true';
    const storageFlag = guestAuthService.isQuickAccessMode();
    return urlParam || storageFlag;
}

// 注入完整 CSS：隐藏管理菜单 / 表单 / 按钮 + 禁用输入可视化
// 由 main.js DOMContentLoaded 调用（在 UIHelper.setupNavigation 之后）
// 幂等：重复调用不会重复注入
export function injectQuickAccessStyle() {
    if (document.getElementById('quickAccessStyle')) return;
    const style = document.createElement('style');
    style.id = 'quickAccessStyle';
    style.textContent = `
        button[data-target="export-data"],
        button[data-target="backup-restore"],
        button[data-admin-only],
        div[data-admin-only],
        #btnExportDashboard,
        #btnAddAtpPoint,
        #btnImportPathogen,
        #btnDownloadTemplate,
        #fileInput,
        #pathogenFileInput,
        .btn-delete,
        .btn-edit,
        .btn-remove-point,
        #tablewareTestForm button[type="submit"],
        #pesticideTestForm button[type="submit"],
        #oilTestForm button[type="submit"],
        #leanMeatTestForm button[type="submit"] {
            display: none !important;
        }
        div.text-xs.text-gray-400.font-semibold {
            display: none !important;
        }
        /* 禁用录入表单操作（视觉提示，输入仍由各模块按 quickAccess 分支 disabled） */
        #tablewareTestForm input,
        #tablewareTestForm select,
        #tablewareTestForm textarea,
        #pesticideTestForm input,
        #pesticideTestForm select,
        #pesticideTestForm textarea,
        #oilTestForm input,
        #oilTestForm select,
        #oilTestForm textarea,
        #leanMeatTestForm input,
        #leanMeatTestForm select,
        #leanMeatTestForm textarea {
            background-color: #f5f5f5 !important;
            cursor: not-allowed !important;
            opacity: 0.8 !important;
        }
    `;
    document.head.appendChild(style);
}
