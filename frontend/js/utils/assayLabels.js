/**
 * 检测项目显示名称的唯一映射入口。
 * 历史记录/学校定制里可能保存了旧名称；展示与下拉统一使用新名称，不改写数据库快照。
 */
export const SULFUR_DIOXIDE_KIT_LABEL = '二氧化硫快速检测试剂盒';

export const SULFUR_DIOXIDE_LEGACY_LABELS = Object.freeze([
    '二氧化硫显色试剂（肉眼判读）',
    '二氧化硫显色试剂',
]);

export function normalizeAssayLabel(value) {
    const text = value == null ? '' : String(value).trim();
    return SULFUR_DIOXIDE_LEGACY_LABELS.includes(text) ? SULFUR_DIOXIDE_KIT_LABEL : value;
}
