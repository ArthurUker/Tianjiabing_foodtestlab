// 手机端把记录表转成「卡片式」：给每个 td 补 data-label（取表头文字），
// 由 mobile.css 在窄屏下切换布局。桌面端不改变任何表格结构。
const TABLE_SELECTOR = 'table.glass-table';

function decorate(table) {
    if (!table || !table.isConnected) return;
    const heads = [...table.querySelectorAll('thead th')].map(th => (th.textContent || '').trim());
    if (!heads.length) return;
    table.classList.add('responsive-cards');
    table.closest('.glass-table-wrap')?.classList.add('responsive-cards');
    for (const row of table.querySelectorAll('tbody tr')) {
        [...row.children].forEach((cell, index) => {
            if (cell.tagName !== 'TD') return;
            const label = heads[index];
            if (!label) { cell.removeAttribute('data-label'); return; }
            if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label);
        });
    }
}

function decorateAll() {
    for (const table of document.querySelectorAll(TABLE_SELECTOR)) decorate(table);
}

export function installResponsiveTables() {
    decorateAll();

    // 记录表由各模块动态渲染：监听 tbody 变化后重新补 label。
    const watched = new WeakSet();
    const watchBody = tbody => {
        if (!tbody || watched.has(tbody)) return;
        watched.add(tbody);
        new MutationObserver(() => decorate(tbody.closest('table'))).observe(tbody, { childList: true });
    };
    const scan = () => {
        for (const tbody of document.querySelectorAll(`${TABLE_SELECTOR} tbody`)) watchBody(tbody);
    };
    scan();

    // 后插入的表格（如餐具模块）也纳入
    new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!node || node.nodeType !== 1) continue;
                if (node.matches?.(TABLE_SELECTOR)) { decorate(node); watchBody(node.querySelector('tbody')); }
                else if (node.querySelector?.(TABLE_SELECTOR)) { node.querySelectorAll(TABLE_SELECTOR).forEach(decorate); scan(); }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    // 首屏模块渲染稍晚，补一次
    setTimeout(decorateAll, 800);
    setTimeout(decorateAll, 2000);
}
