/**
 * 控制台 KPI 定时刷新（P-Refactor：从 adminSidebar.js 拆分）。
 *
 * 三个轻量轮询均从「渲染后的 DOM」推断数量（最小侵入，不直接依赖数据层）：
 *   1. refreshKpi           总览卡片：学校总数 / 启用数 / 回收站数
 *   2. refreshRecycleBadge  侧边栏「学校管理」回收站数量徽标
 *   3. refreshSuperAdminKpi 顶部平台超管计数
 */
export function initKpiPoller() {
    // KPI 数据填充：从原页面渲染后的 DOM 推断（最小侵入）。
    // 学校列表 tbody id = schoolTbody；回收站是独立 table（在 recycleBinList 内），
    // 二者分开统计，避免把回收站误算进「学校总数」。
    function refreshKpi() {
        try {
            const schoolRows = document.querySelectorAll('#schoolTbody tr');
            // 排除「加载中…/暂无学校」这类占位行（真实行必含操作按钮 .btn-manage）
            const realRows = Array.from(schoolRows).filter((tr) => tr.querySelector('.btn-manage'));
            const total = realRows.length;
            let active = 0;
            realRows.forEach((tr) => {
                if ((tr.textContent || '').includes('启用')) active++;
            });
            const recycled = document.querySelectorAll('#recycleBinList tbody tr').length;
            if (document.getElementById('kpiTotalSchools')) document.getElementById('kpiTotalSchools').textContent = total;
            if (document.getElementById('kpiActiveSchools')) document.getElementById('kpiActiveSchools').textContent = active;
            if (document.getElementById('kpiRecycleSchools')) document.getElementById('kpiRecycleSchools').textContent = recycled;
        } catch (e) { /* 静默 */ }
    }
    // 初次刷新 + 列表刷新后定时刷新 KPI（用 MutationObserver 太重，简单 setInterval 即可）
    setTimeout(refreshKpi, 1500);
    setInterval(refreshKpi, 8000);

    // 回收站数量徽标（recycleBinList 渲染为 <table><tbody><tr>，用 tbody tr 统计）
    function refreshRecycleBadge() {
        try {
            const recycleCount = document.querySelectorAll('#recycleBinList tbody tr').length;
            const badge = document.getElementById('adminSidebarBadgeSchools');
            if (!badge) return;
            const n = parseInt(recycleCount, 10);
            if (n > 0) {
                badge.textContent = n;
                badge.removeAttribute('hidden');
            } else {
                badge.setAttribute('hidden', '');
            }
        } catch (e) { /* 静默 */ }
    }
    setTimeout(refreshRecycleBadge, 2000);
    setInterval(refreshRecycleBadge, 8000);

    // 顶部 super_admin 统计（软实现，从 super_admin 弹层渲染后的列表行推断）
    function refreshSuperAdminKpi() {
        try {
            // 超管列表 tbody id = saAdminList（SuperAdminAccount.js 的 listEl）
            const rows = document.querySelectorAll('#saAdminList tr');
            if (document.getElementById('kpiSuperAdmins')) {
                document.getElementById('kpiSuperAdmins').textContent = rows.length || '?';
            }
        } catch (e) { /* 静默 */ }
    }
    setInterval(refreshSuperAdminKpi, 8000);
}
