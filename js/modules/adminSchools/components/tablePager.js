/**
 * 通用表格分页组件
 * - 支持客户端分页（传入 total）与服务器端分页（外部设置 total）
 * - 统一 UI：显示信息、每页条数、上一页/下一页、页码按钮、跳转输入
 */
export class TablePager {
    constructor(options = {}) {
        this.id = options.id || `pager-${Math.random().toString(36).slice(2, 9)}`;
        this.containerId = options.containerId;
        this.perPageOptions = options.perPageOptions || [5, 10, 20, 50];
        this.defaultPerPage = options.defaultPerPage || 10;
        this.showPerPage = options.showPerPage !== false;
        this.showJump = options.showJump !== false;
        this.showInfo = options.showInfo !== false;
        this.serverSide = options.serverSide === true;
        this.onChange = options.onChange || (() => {});

        this.page = 1;
        this.perPage = this.defaultPerPage;
        this.total = 0;
        this._mounted = false;
    }

    get totalPages() {
        return Math.max(1, Math.ceil(this.total / this.perPage));
    }

    get state() {
        const start = this.total === 0 ? 0 : (this.page - 1) * this.perPage + 1;
        const end = Math.min(this.page * this.perPage, this.total);
        return { page: this.page, perPage: this.perPage, total: this.total, totalPages: this.totalPages, start, end };
    }

    mount(containerId) {
        if (containerId) this.containerId = containerId;
        const container = document.getElementById(this.containerId);
        if (!container) return this;
        container.innerHTML = this._html();
        this._bind();
        this._mounted = true;
        this.render();
        return this;
    }

    setTotal(total) {
        this.total = Number(total) || 0;
        this.page = Math.max(1, Math.min(this.page, this.totalPages));
        this.render();
        return this;
    }

    setPage(page) {
        this.page = Math.max(1, Math.min(Number(page) || 1, this.totalPages));
        this.render();
        return this;
    }

    setPerPage(perPage) {
        this.perPage = Number(perPage) || this.defaultPerPage;
        this.page = 1;
        this.render();
        return this;
    }

    reset(page = 1) {
        this.page = page;
        this.render();
        return this;
    }

    _html() {
        const id = this.id;
        return `
            <div class="table-pager flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
                ${this.showInfo ? `<div class="table-pager__info" id="${id}_info">加载中…</div>` : '<div></div>'}
                <div class="flex flex-wrap items-center gap-2">
                    ${this.showPerPage ? `
                        <label class="flex items-center gap-1 text-sm text-gray-600">
                            每页
                            <select id="${id}_perPage" class="border border-gray-300 rounded px-2 py-1 text-sm bg-white/80">
                                ${this.perPageOptions.map((n) => `<option value="${n}" ${n === this.perPage ? 'selected' : ''}>${n}</option>`).join('')}
                            </select>
                            条
                        </label>
                    ` : ''}
                    <div class="flex items-center space-x-1">
                        <button type="button" id="${id}_prev" class="px-3 py-1 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition"><i class="fas fa-chevron-left"></i></button>
                        <div id="${id}_pages" class="flex items-center space-x-1"></div>
                        <button type="button" id="${id}_next" class="px-3 py-1 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition"><i class="fas fa-chevron-right"></i></button>
                    </div>
                    ${this.showJump ? `
                        <form id="${id}_jump" class="flex items-center gap-1 ml-1">
                            <input type="number" id="${id}_jumpInput" min="1" class="border border-gray-300 rounded w-14 px-2 py-1 text-sm bg-white/80" placeholder="页">
                            <button type="submit" class="px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 transition"><i class="fas fa-arrow-right text-xs"></i></button>
                        </form>
                    ` : ''}
                </div>
            </div>
        `;
    }

    _bind() {
        const id = this.id;
        document.getElementById(`${id}_prev`)?.addEventListener('click', () => {
            if (this.page > 1) {
                this.page--;
                this._notify();
            }
        });
        document.getElementById(`${id}_next`)?.addEventListener('click', () => {
            if (this.page < this.totalPages) {
                this.page++;
                this._notify();
            }
        });
        document.getElementById(`${id}_pages`)?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-page]');
            if (!btn) return;
            const page = parseInt(btn.dataset.page, 10);
            if (page && page !== this.page) {
                this.page = page;
                this._notify();
            }
        });
        document.getElementById(`${id}_perPage`)?.addEventListener('change', (e) => {
            this.perPage = parseInt(e.target.value, 10);
            this.page = 1;
            this._notify();
        });
        document.getElementById(`${id}_jump`)?.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById(`${id}_jumpInput`);
            const page = parseInt(input?.value, 10);
            if (page && page >= 1 && page <= this.totalPages) {
                this.page = page;
                this._notify();
            }
            if (input) input.value = '';
        });
    }

    _notify() {
        this.render();
        this.onChange({ ...this.state });
    }

    render() {
        if (!this._mounted) return;
        const id = this.id;
        const info = document.getElementById(`${id}_info`);
        if (info) {
            info.textContent = this.total === 0 ? '暂无记录' : `显示 ${this.state.start}-${this.state.end} 条，共 ${this.total} 条`;
        }
        const prev = document.getElementById(`${id}_prev`);
        const next = document.getElementById(`${id}_next`);
        if (prev) prev.disabled = this.page <= 1;
        if (next) next.disabled = this.page >= this.totalPages;

        const pages = document.getElementById(`${id}_pages`);
        if (pages) pages.innerHTML = this._renderPageButtons();
    }

    _renderPageButtons() {
        const total = this.totalPages;
        const current = this.page;
        if (total <= 1) return '';

        let startPage = Math.max(1, current - 2);
        let endPage = Math.min(total, startPage + 4);
        if (endPage - startPage < 4) {
            startPage = Math.max(1, endPage - 4);
        }

        let html = '';
        if (startPage > 1) {
            html += `<button type="button" data-page="1" class="px-2.5 py-1 rounded text-sm transition ${1 === current ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-white border border-gray-200 hover:bg-gray-100'}">1</button>`;
            if (startPage > 2) html += '<span class="px-1 text-gray-400">…</span>';
        }
        for (let i = startPage; i <= endPage; i++) {
            html += `<button type="button" data-page="${i}" class="px-2.5 py-1 rounded text-sm transition ${i === current ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-white border border-gray-200 hover:bg-gray-100'}">${i}</button>`;
        }
        if (endPage < total) {
            if (endPage < total - 1) html += '<span class="px-1 text-gray-400">…</span>';
            html += `<button type="button" data-page="${total}" class="px-2.5 py-1 rounded text-sm transition ${total === current ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-white border border-gray-200 hover:bg-gray-100'}">${total}</button>`;
        }
        return html;
    }
}

/**
 * 客户端数组分页辅助函数
 */
export function paginateArray(array, page, perPage) {
    const total = array.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    page = Math.max(1, Math.min(Number(page) || 1, totalPages));
    const start = (page - 1) * perPage;
    return {
        page,
        perPage,
        total,
        totalPages,
        start: start + 1,
        end: Math.min(start + perPage, total),
        data: array.slice(start, start + perPage),
    };
}
