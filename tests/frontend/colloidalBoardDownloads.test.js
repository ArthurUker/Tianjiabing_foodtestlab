import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'frontend/pages/index.html'), 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const section = doc.getElementById('colloidal-board-downloads');

const boards = [
    { key: 'A4', name: 'CG-A4-DEMO-V0.1', page: [210, 297], markerIds: [0, 1, 2, 3, 10, 11, 12, 13] },
    { key: 'A5', name: 'CG-A5-INNER-V0.1', page: [148, 210], markerIds: [10, 11, 12, 13] },
];

function sourcePath(href) {
    return path.join(root, 'frontend', href.replace(/^\/+/, ''));
}

describe('学校管理 / 胶体金定位卡下载', () => {
    test('管理分组菜单与静态内容区使用同一导航目标', () => {
        const nav = doc.querySelector('[data-target="colloidal-board-downloads"]');
        const adminHeader = doc.querySelector('[data-section-title="admin"]');
        expect(nav).toBeTruthy();
        expect(section).toBeTruthy();
        expect(section.classList.contains('content-section')).toBe(true);
        expect(section.classList.contains('hidden')).toBe(true);
        expect(nav.hasAttribute('data-admin-only')).toBe(true);
        const siblings = Array.from(adminHeader.parentElement.children);
        expect(siblings.indexOf(nav)).toBeGreaterThan(siblings.indexOf(adminHeader));
    });

    test.each(boards)('$key 提供真实存在的 PDF 和 SVG 下载及安全的打印链接', ({ name }) => {
        for (const extension of ['pdf', 'svg']) {
            const href = `/vendor/colloidal/boards/${name}.${extension}`;
            const download = section.querySelector(`a[download][href="${href}"]`);
            expect(download).toBeTruthy();
            expect(download.getAttribute('download').endsWith(`.${extension}`)).toBe(true);
            const file = sourcePath(href);
            expect(fs.existsSync(file)).toBe(true);
            const content = fs.readFileSync(file);
            expect(content.length).toBeGreaterThan(1000);
            if (extension === 'pdf') expect(content.subarray(0, 5).toString()).toBe('%PDF-');
            else expect(content.toString()).toContain('<svg');
        }

        const printLinks = Array.from(section.querySelectorAll(`a[href$="${name}.pdf"][target="_blank"]`));
        expect(printLinks.length).toBeGreaterThanOrEqual(2);
        for (const link of printLinks) expect(link.getAttribute('rel')).toContain('noopener');
    });

    test.each(boards)('$key 毫米版式和定位码元数据完整', ({ name, page, markerIds }) => {
        const layout = JSON.parse(fs.readFileSync(sourcePath(`/vendor/colloidal/boards/${name}.json`), 'utf8'));
        expect(layout.page_mm).toEqual(page);
        expect(layout.dictionary).toBe('DICT_4X4_50');
        expect(layout.markers.map((marker) => marker.id)).toEqual(markerIds);
        for (const marker of layout.markers) {
            expect(marker.size_mm).toBeGreaterThanOrEqual(15);
            expect(marker.matrix_6x6).toHaveLength(6);
            for (const row of marker.matrix_6x6) {
                expect(row).toHaveLength(6);
                expect(row.every((value) => value === 0 || value === 255)).toBe(true);
            }
        }
    });

    test('页面包含原尺寸打印和实拍门槛说明', () => {
        expect(section.textContent).toContain('100%');
        expect(section.textContent).toContain('50 mm');
        expect(section.textContent).toContain('3000px');
        expect(section.textContent).toContain('至少 3 个清晰定位码');
        expect(section.textContent).toContain('单卡近照或固定机位');
    });
});
