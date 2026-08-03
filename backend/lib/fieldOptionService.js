// fieldOptionService.js — 动态表单字段级联配置（FieldOption 表）唯一数据访问层
//
// 职责：
//   1. 种子：ensureFieldOptionSeeds —— 新租户 / 历史租户首次同步时，为 (module, field)
//      顶级选项为空的字段插入系统默认选项（幂等）。
//   2. 查询：listFieldOptions / buildFieldCascade —— 把扁平行组装为任意层级树，
//      供管理端编辑器与录入端（/api/schools/:code/config 注入 field_cascade）消费。
//   3. 写入：replaceFieldOptions（整树替换，管理端"保存"用）+ 单条 create/update/delete。
//   4. 删除保护：有子选项的父选项禁止删除（历史记录为文本快照，故不强制引用计数）。
//
// 跨字段级联语义：testType 顶级选项的 children 是 location 字段的选项行
// （children.field_code = FIELD_OPTION_SEEDS[module][field].cascadeTarget）。
// 顶级行唯一性（parent_option_id IS NULL）由应用层查重保证（PG 唯一索引对 NULL 不生效）。

import { createTenantClient } from './tenantClient.js'
import { FIELD_OPTION_SEEDS, TABLE_MANAGED_FIELDS } from './fieldOptionSeeds.js'

const MODULE_CODE_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
const FIELD_CODE_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const VALUE_MAX = 100

/** 归一化选项定义：字符串 → { value, label, sortOrder, isDefault, children } */
export function normalizeOption(opt) {
  if (typeof opt === 'string') {
    const v = opt.trim()
    if (!v) throw new Error('选项值不能为空')
    return { value: v, label: v, sortOrder: 0, isDefault: false, children: [] }
  }
  const o = opt && typeof opt === 'object' ? opt : {}
  const value = String(o.value ?? o.label ?? '').trim()
  if (!value) throw new Error('选项 value 不能为空')
  if (value.length > VALUE_MAX) throw new Error(`选项值过长（≤${VALUE_MAX}字符）`)
  const label = (o.label != null && String(o.label).trim()) || value
  if (label.length > VALUE_MAX) throw new Error(`选项显示文本过长（≤${VALUE_MAX}字符）`)
  const children = Array.isArray(o.children) ? o.children.map(normalizeOption) : []
  if (children.length > 50) throw new Error('子选项数量超过上限（≤50）')
  return {
    value,
    label,
    sortOrder: Number.isInteger(o.sortOrder) ? o.sortOrder : 0,
    isDefault: !!o.isDefault,
    children,
  }
}

function validateScope(module, field) {
  if (!module || !MODULE_CODE_RE.test(module)) throw new Error('模块码非法')
  if (!field || !FIELD_CODE_RE.test(field)) throw new Error('字段名非法')
}

/** 子选项归属的目标字段码（默认同字段 = 同字段多级树） */
function cascadeTargetOf(module, field) {
  return FIELD_OPTION_SEEDS[module]?.[field]?.cascadeTarget || field
}

function fetchRows(db, where) {
  return db.fieldOption.findMany({
    where,
    // 保持 sort_order + 插入顺序（created_at），避免按 value 字典序打乱中文种子顺序
    orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
  })
}

function shape(node) {
  return {
    id: node.id,
    value: node.value,
    label: node.label,
    sortOrder: node.sort_order,
    isDefault: node.is_default,
    isBuiltin: node.is_builtin,
    children: (node.children || []).map(shape),
  }
}

function sortRec(nodes) {
  nodes.sort((a, b) => (a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : 0))
  nodes.forEach((n) => sortRec(n.children))
  return nodes
}

/**
 * 同 module 的扁平行 → 按 field_code 分组的树。
 * 关键：先建立全 module 的 id→node 映射再挂 children，保证【跨字段级联】成立——
 * 子选项行（如 tableware.location 的"餐具表面"）的 parent 是 testType 行，
 * parent 不在 location 分组内也能正确挂载到 testType 节点下。
 */
function rowsToModuleCascade(rows) {
  const byId = new Map()
  for (const r of rows) byId.set(r.id, { ...r, children: [] })
  const tops = []
  for (const r of rows) {
    const node = byId.get(r.id)
    if (r.parent_option_id && byId.has(r.parent_option_id)) {
      byId.get(r.parent_option_id).children.push(node)
    } else {
      tops.push(node)
    }
  }
  const out = {}
  for (const node of tops) {
    if (!out[node.field_code]) out[node.field_code] = []
    out[node.field_code].push(node)
  }
  for (const fc of Object.keys(out)) out[fc] = sortRec(out[fc]).map(shape)
  return out
}

/** 构建全部级联字段的注入结构：{ module: { field: [tree] } }（供录入端/管理端） */
export async function buildFieldCascade(db) {
  const modules = Object.keys(FIELD_OPTION_SEEDS)
  if (!modules.length) return {}
  const rows = await fetchRows(db, { module_code: { in: modules } })
  const byModule = {}
  for (const r of rows) {
    if (!byModule[r.module_code]) byModule[r.module_code] = []
    byModule[r.module_code].push(r)
  }
  const out = {}
  for (const mc of Object.keys(byModule)) out[mc] = rowsToModuleCascade(byModule[mc])
  return out
}

/**
 * 列出某模块（可选字段）的选项树。
 * 实现：拉取同 module 全部行组装（保证跨字段 children 挂载正确），再取目标 field 分组。
 * @returns module 与 field 都指定 → 数组（该字段顶级树，含其下 children）；
 *          仅指定 module → { field_code: [tree] }
 */
export async function listFieldOptions(db, { module, field }) {
  validateScope(module, field || 'x')
  const rows = await fetchRows(db, { module_code: module })
  const cascade = rowsToModuleCascade(rows)
  if (field) return cascade[field] || []
  return cascade
}

/**
 * 种子回填（幂等）：某 (module, field) 顶级选项为空时插入系统默认选项。
 * 供 tenantSync 跨全部租户调用 + 新建学校 provision 后调用。
 * @returns {Promise<number>} 本次插入的行数
 */
export async function ensureFieldOptionSeeds(prisma, code, log = () => {}) {
  const db = createTenantClient(prisma, code)
  let inserted = 0
  for (const [module, fields] of Object.entries(FIELD_OPTION_SEEDS)) {
    for (const [field, def] of Object.entries(fields)) {
      const topCount = await db.fieldOption.count({
        where: { module_code: module, field_code: field, parent_option_id: null },
      })
      if (topCount > 0) continue // 已配置过（含用户清空后自定义），不覆盖
      const childField = def.cascadeTarget || field
      for (const raw of def.options || []) {
        const opt = normalizeOption(raw)
        const parent = await db.fieldOption.create({
          data: {
            module_code: module,
            field_code: field,
            value: opt.value,
            label: opt.label,
            sort_order: opt.sortOrder,
            is_default: opt.isDefault,
            is_builtin: true,
          },
        })
        inserted++
        for (const child of opt.children) {
          await db.fieldOption.create({
            data: {
              module_code: module,
              field_code: childField,
              value: child.value,
              label: child.label,
              parent_option_id: parent.id,
              sort_order: child.sortOrder,
              is_builtin: true,
            },
          })
          inserted++
        }
      }
      log(`  ✅ FieldOption 种子: ${module}.${field}（${(def.options || []).length} 顶级选项）`)
    }
  }
  return inserted
}

/**
 * 整树替换某 (module, field) 的选项（管理端"保存级联"调用）。
 * 事务内：删除该字段全部顶级行（FK ON DELETE CASCADE 连带删除子选项）→ 重新插入。
 * @returns {Promise<{created: number}>}
 */
export async function replaceFieldOptions(db, payload) {
  const { module_code, field_code, options } = payload || {}
  validateScope(module_code, field_code)
  if (!Array.isArray(options)) throw new Error('options 必须是数组')
  if (options.length > 200) throw new Error('顶级选项数量超过上限（≤200）')
  const norm = options.map(normalizeOption)
  const childField = cascadeTargetOf(module_code, field_code)
  const created = await db.$transaction(async (tx) => {
    await tx.fieldOption.deleteMany({
      where: { module_code, field_code, parent_option_id: null },
    })
    let n = 0
    for (const opt of norm) {
      const parent = await tx.fieldOption.create({
        data: {
          module_code,
          field_code,
          value: opt.value,
          label: opt.label,
          sort_order: opt.sortOrder,
          is_default: opt.isDefault,
          is_builtin: false,
        },
      })
      n++
      for (const child of opt.children) {
        await tx.fieldOption.create({
          data: {
            module_code,
            field_code: childField,
            value: child.value,
            label: child.label,
            parent_option_id: parent.id,
            sort_order: child.sortOrder,
            is_builtin: false,
          },
        })
        n++
      }
    }
    return n
  })
  return { created }
}

/** 创建单条选项（查重含 NULL 顶级）。 */
export async function createFieldOption(db, data) {
  const module_code = String(data.module_code || '')
  const field_code = String(data.field_code || '')
  validateScope(module_code, field_code)
  const value = String(data.value ?? '').trim()
  const label = (data.label != null && String(data.label).trim()) || value
  const parent_option_id = data.parent_option_id ?? null
  const sort_order = Number.isInteger(data.sort_order) ? data.sort_order : 0
  const is_default = !!data.is_default
  if (!value) throw new Error('选项值不能为空')
  if (value.length > VALUE_MAX) throw new Error(`选项值过长（≤${VALUE_MAX}字符）`)
  if (label.length > VALUE_MAX) throw new Error(`选项显示文本过长（≤${VALUE_MAX}字符）`)
  const exists = await db.fieldOption.findFirst({
    where: { module_code, field_code, value, parent_option_id },
  })
  if (exists) throw new Error('同层级已存在该选项')
  return db.fieldOption.create({
    data: { module_code, field_code, value, label, parent_option_id, sort_order, is_default },
  })
}

/** 更新单条选项（value/重新挂载父级时查重）。 */
export async function updateFieldOption(db, id, data) {
  const row = await db.fieldOption.findUnique({ where: { id } })
  if (!row) throw new Error('选项不存在')
  const patch = {}
  if (data.value !== undefined) {
    const value = String(data.value).trim()
    if (!value) throw new Error('选项值不能为空')
    if (value.length > VALUE_MAX) throw new Error(`选项值过长（≤${VALUE_MAX}字符）`)
    patch.value = value
  }
  if (data.label !== undefined) {
    const label = String(data.label).trim()
    if (!label) throw new Error('选项显示文本不能为空')
    if (label.length > VALUE_MAX) throw new Error(`选项显示文本过长（≤${VALUE_MAX}字符）`)
    patch.label = label
  }
  if (data.sort_order !== undefined) patch.sort_order = Number.isInteger(data.sort_order) ? data.sort_order : 0
  if (data.is_default !== undefined) patch.is_default = !!data.is_default
  if (data.parent_option_id !== undefined) patch.parent_option_id = data.parent_option_id || null

  if (patch.value !== undefined || patch.parent_option_id !== undefined) {
    const exists = await db.fieldOption.findFirst({
      where: {
        module_code: row.module_code,
        field_code: row.field_code,
        value: patch.value !== undefined ? patch.value : row.value,
        parent_option_id: patch.parent_option_id !== undefined ? patch.parent_option_id : row.parent_option_id,
        NOT: { id },
      },
    })
    if (exists) throw new Error('同层级已存在同名选项')
  }
  return db.fieldOption.update({ where: { id }, data: patch })
}

/** 删除单条选项（有子选项时拒绝——删除保护）。 */
export async function deleteFieldOption(db, id) {
  const row = await db.fieldOption.findUnique({ where: { id } })
  if (!row) throw new Error('选项不存在')
  const childCount = await db.fieldOption.count({ where: { parent_option_id: id } })
  if (childCount > 0) {
    throw new Error(`该选项下还有 ${childCount} 个子选项，请先删除或移除子选项后再删除`)
  }
  await db.fieldOption.delete({ where: { id } })
  return true
}

/** 校验是否为 FieldOption 表管理的 (module, field)（供路由/前端判定） */
export function isTableManagedField(module, field) {
  return Array.isArray(TABLE_MANAGED_FIELDS[module]) && TABLE_MANAGED_FIELDS[module].includes(field)
}

export { TABLE_MANAGED_FIELDS }
