// Business mapping only. Geometry and IFU implementation come from the frozen core.
export const CORE_COMMIT = 'a0e9d274f5df2bc1ec85f4b6df04f4f81b4c98da';
export const PIPELINE = 'project-marker-quality-20261018-v5';
// 识别核心本地补丁标识（几何判据 geom1）；未打补丁的核心回执不含该字段。
export const CORE_PATCH = 'geom1';
const single = (id, name, module, label = `${name}-胶体金检测卡`) => ({ id, name, module, label, channels: [{ id, name, label }] });
export const PROJECTS = [
    single('carbofuran', '克百威', 'pesticide'),
    single('isocarbophos', '水胺硫磷', 'pesticide'),
    single('thiamethoxam', '噻虫嗪', 'pesticide'),
    single('enrofloxacin', '恩诺沙星', 'leanMeat'),
    single('florfenicol', '氟苯尼考', 'leanMeat'),
    single('lead', '铅', 'leanMeat', '铅-重金属检测（GB 2762 鱼虾类≤0.5mg/kg）'),
    single('cadmium', '镉', 'leanMeat', '镉-重金属检测（GB 2762 鱼虾类≤0.1mg/kg）'),
    { id: 'lean_meat_triplex', name: '瘦肉精三联', module: 'leanMeat', label: '瘦肉精三联-胶体金检测卡',
        channels: ['盐酸克伦特罗', '莱克多巴胺', '沙丁胺醇'].map((name, i) => ({
            id: ['clenbuterol', 'ractopamine', 'salbutamol'][i], name, label: `${name}-胶体金检测卡`,
        })) },
];
export const projectById = id => PROJECTS.find(p => p.id === id);
export const projectByLabel = (module, label) => PROJECTS.find(p => p.module === module && p.label === label);
export const resultText = value => ({ positive: '不合格', negative: '合格' }[value] || null);

// getRandomValues also works on ordinary HTTP; randomUUID requires HTTPS.
export function newEntryId() {
    const native = globalThis.crypto?.randomUUID?.();
    if (native) return native;
    if (!globalThis.crypto?.getRandomValues) throw new Error('当前浏览器缺少安全随机数支持');
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
