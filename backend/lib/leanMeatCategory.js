// leanMeatCategory.js — 肉蛋类「品种」归类为看板 6 个卡片键的**单一规则**（2026-09-24 修复）
//
// 背景（线上真实缺陷）：看板肉蛋子卡用硬编码精确匹配 {猪肉/羊肉/牛肉/禽肉/鱼肉/禽蛋}，
// 而库里实际存在 `鱼、虾`（school_zhsy 2 条、school_zhyz 4 条、school_tjb 1 条）与 `鱼肉` 两种写法 →
// `鱼、虾` 记录**不落入任何卡片**（看板"鱼肉 0"，实际有数）。此外子卡此前只读本地缓存，
// 服务端聚合只校正 5 个类型卡，缓存漂移时子卡会与库内不符（截图 6/6/2/2=16 vs 库内 15 条）。
//
// 规则：按"包含关键词"归类，永远落到 6 个卡片键之一或 null（未分类，忽略不显示）。
// 注意顺序：先判「蛋」，否则「禽蛋」会被「禽」抢走。
export const MEAT_CARD_KEYS = ['猪肉', '羊肉', '牛肉', '禽肉', '鱼肉', '禽蛋']

export function normalizeMeatKey(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (s.includes('蛋')) return '禽蛋'
  if (s.includes('猪')) return '猪肉'
  if (s.includes('羊')) return '羊肉'
  if (s.includes('牛')) return '牛肉'
  if (s.includes('禽') || /鸡|鸭|鹅|鸽/.test(s)) return '禽肉'
  if (/鱼|虾|蟹|贝|海鲜/.test(s)) return '鱼肉'
  return null
}
