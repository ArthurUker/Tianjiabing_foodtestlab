/**
 * schoolCustomization.js（RK51：聚合入口 / re-export 门面）
 * 跨页面存取当前学校的个性化配置（SchoolCustomization），并把它合并到表单字段定义。
 * 数据来源：登录页 / 主应用调用 GET /api/schools/:schoolCode/config 后写入 localStorage。
 *
 * 该模块让"统一代码 + 按校个性化"落地：学校名、界面主题、字段标签/显隐/必填规则
 * 全部来自 public 系统表，业务代码不出现任何学校专有命名。
 *
 * ⚠️ RK51 拆分说明：实现已按职责拆分到 ./schoolCustomization/ 子模块，
 * 本文件仅做统一 re-export，保证所有现有
 *   import { ... } from '.../utils/schoolCustomization.js'
 * 路径与命名导出不变。新代码可继续从本入口导入（推荐），也可直接导入子模块。
 *
 * 子模块职责：
 *   - schoolCustomization/cache.js    缓存层（localStorage / TTL(RK15) / in-flight(CR-02) /
 *                                     登出清缓存(RK14/RK26/RK27) / 跨标签页同步(CR-06)）
 *   - schoolCustomization/fields.js   字段定制（标签/显隐/必填/选项/顺序 + 层级A 自定义字段
 *                                     inject/collect + RK21 合格判定 qualify）
 *   - schoolCustomization/visible.js  模块可见性（RK3 visible_types → 导航/区块显隐）
 *   - schoolCustomization/branding.js 品牌与标题（校名/校徽 RK9 白名单 / section_titles）
 *   - schoolCustomization/shared.js   内部共享工具（JSON 解析等，不对外导出）
 */

export {
    setSchoolCustomization,
    getSchoolCustomization,
    clearSchoolConfigCache,
    setSchoolInfo,
    getSchoolInfo,
    ensureSchoolConfig,
    ensureSchoolInfo,
    onSchoolConfigChanged,
    onSchoolInfoChanged,
    notifySchoolInfoChanged,
} from './schoolCustomization/cache.js'

export {
    applyCustomizationToFields,
    applySchoolCustomizationToForm,
    applyCustomizationToAllForms,
    resolveCustomFields,
    injectCustomFields,
    collectCustomFieldValues,
    isRecordQualifiedByCustomFields,
} from './schoolCustomization/fields.js'

export {
    getVisibleTypes,
    applyVisibleTypesToNav,
} from './schoolCustomization/visible.js'

export {
    applySchoolBranding,
    applySchoolCustomizationToTitles,
} from './schoolCustomization/branding.js'

import {
    setSchoolCustomization,
    getSchoolCustomization,
    clearSchoolConfigCache,
    setSchoolInfo,
    getSchoolInfo,
    ensureSchoolConfig,
    ensureSchoolInfo,
    onSchoolConfigChanged,
    onSchoolInfoChanged,
    notifySchoolInfoChanged,
} from './schoolCustomization/cache.js'
import {
    applyCustomizationToFields,
    applySchoolCustomizationToForm,
    applyCustomizationToAllForms,
    resolveCustomFields,
    injectCustomFields,
    collectCustomFieldValues,
    isRecordQualifiedByCustomFields,
} from './schoolCustomization/fields.js'
import { getVisibleTypes, applyVisibleTypesToNav } from './schoolCustomization/visible.js'
import { applySchoolBranding, applySchoolCustomizationToTitles } from './schoolCustomization/branding.js'

export default {
    setSchoolCustomization,
    getSchoolCustomization,
    clearSchoolConfigCache,
    resolveCustomFields,
    injectCustomFields,
    collectCustomFieldValues,
    isRecordQualifiedByCustomFields,
    setSchoolInfo,
    getSchoolInfo,
    ensureSchoolInfo,
    applySchoolBranding,
    applyCustomizationToFields,
    applySchoolCustomizationToForm,
    applyCustomizationToAllForms,
    applySchoolCustomizationToTitles,
    applyVisibleTypesToNav,
    getVisibleTypes,
    onSchoolConfigChanged,
    onSchoolInfoChanged,
    notifySchoolInfoChanged,
    ensureSchoolConfig,
}
