/**
 * 示例数据生成器
 * 为快速访问模式生成示例检测数据
 */
import { getSchoolCustomization, resolveCustomFields } from './schoolCustomization.js';
import { getLocalDateStr } from './dateUtil.js';
// TD-CascadeFieldOption: 同样需要 schoolCode；快速访问模式下空 customization 会导致示例数据
// 永远不带学校定制字段，体验与正式租户不一致。
import { extractSchoolCode } from './schoolCode.js';
// P3-CONS-T01（AUD-001 收口，W4 未决 #1）：旧键 cache_<table> 直读 → 作用域键
// cache_v2__<tenant>__<subjectHash>__<res>。键派生与 StorageService#getStorageKeys() 完全同源
// （core/SyncScope.buildScopedKeys —— Storage.js 构造函数内部即用它生成本地缓存键）。
// 此处不经 StorageService 实例取键：其构造函数会用 {data:[]} 初始化缓存键，
// 破坏本模块「只初始化缺失数据」的键存在性判断（initializeSampleData 的既有逻辑，保持不变）。
import { resolveSyncScope, buildScopedKeys } from '../core/SyncScope.js';

const SAMPLE_TYPES = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
const _scopedCacheKeyCache = new Map();
function scopedCacheKey(type) {
    if (!_scopedCacheKeyCache.has(type)) {
        _scopedCacheKeyCache.set(type, buildScopedKeys(type, resolveSyncScope()).cacheKey);
    }
    return _scopedCacheKeyCache.get(type);
}

// RK45: 为学校自定义字段补示例值，避免快速访问示例数据缺少定制字段
function withCustomFields(moduleCode, record) {
    const defs = resolveCustomFields(getSchoolCustomization(extractSchoolCode()), moduleCode)
    if (!defs.length) return record
    const extra = {}
    defs.forEach((d, i) => { extra[d.name] = d.label ? `示例${i + 1}` : '' })
    return Object.assign({}, record, extra)
}

export function initializeSampleData() {
    // 检查是否是快速访问模式
    const urlParams = new URLSearchParams(window.location.search);
    const isQuickAccess = urlParams.get('quickAccess') === 'true';
    
    if (!isQuickAccess) return;
    
    console.log('📊 初始化示例数据用于快速访问模式...');

    // ✨ 只初始化缺失的数据，保留现有数据（键来源：P3-CONS-T01 迁移为作用域键）
    const existingKeys = new Set(SAMPLE_TYPES.map(scopedCacheKey));

    // 只初始化缺失的缓存
    if (!existingKeys.has(scopedCacheKey('tableware'))) {
        console.log('📊 初始化缺失的餐具洁净度数据...');
        initTableware();
    } else {
        console.log('✅ 缓存已存在，跳过初始化餐具洁净度数据');
    }

    if (!existingKeys.has(scopedCacheKey('pesticide'))) initPesticide();
    else console.log('✅ 缓存已存在，跳过初始化果蔬农残数据');

    if (!existingKeys.has(scopedCacheKey('oil'))) initOil();
    else console.log('✅ 缓存已存在，跳过初始化食用油品质数据');

    if (!existingKeys.has(scopedCacheKey('leanMeat'))) initMeat();
    else console.log('✅ 缓存已存在，跳过初始化肉蛋农残数据');

    if (!existingKeys.has(scopedCacheKey('pathogen'))) initPathogen();
    else console.log('✅ 缓存已存在，跳过初始化病原体数据');
    
    // initDashboard();  // 仪表板数据不需要示例数据
    
    // 触发数据变化事件
    setTimeout(() => {
        console.log('🔄 触发数据变化事件...');
        try {
            document.dispatchEvent(new Event('dataChanged'));
        } catch (e) {
            console.log('⚠️ 事件触发失败:', e);
        }
    }, 100);
}

/**
 * 初始化餐具洁净度检测示例数据
 */
function initTableware() {
    const storageKey = scopedCacheKey('tableware'); // P3-CONS-T01：作用域键（原 'cache_tableware'）

    // P1-22: 示例数据 ID 改用 temp_sample_{n}，兼容 StorageService._isTempId() 规则避免同步时被丢弃
    const sampleData = [
        {
            id: 'temp_sample_1',
            testDate: getLocalDateStr(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)),
            canteen: '一食堂',
            inspector: '检测员A',
            atpPoints: [
                { loc: '餐具表面', rluValue: 150, result: '合格' },
                { loc: '操作台', rluValue: 320, result: '警戒' }
            ],
            finalStatus: '合格'
        },
        {
            id: 'temp_sample_2',
            testDate: getLocalDateStr(new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)),
            canteen: '二食堂',
            inspector: '检测员B',
            atpPoints: [
                { loc: '盘子表面', rluValue: 100, result: '合格' },
                { loc: '锅具', rluValue: 250, result: '警戒' }
            ],
            finalStatus: '合格'
        },
        {
            id: 'temp_sample_3',
            testDate: getLocalDateStr(new Date()),
            canteen: '一食堂',
            inspector: '检测员A',
            atpPoints: [
                { loc: '餐具表面', rluValue: 50, result: '合格' }
            ],
            finalStatus: '合格'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({ data: sampleData.map(r => withCustomFields('tableware', r)) }));
    console.log('✅ 初始化餐具洁净度示例数据:', sampleData.length, '条');
}

/**
 * 初始化果蔬农残检测示例数据
 */
function initPesticide() {
    const storageKey = scopedCacheKey('pesticide'); // P3-CONS-T01：作用域键（原 'cache_pesticide'）

    // P1-22: 示例数据 ID 改用 temp_sample_{n}，兼容 StorageService._isTempId() 规则避免同步时被丢弃
    const sampleData = [
        {
            id: 'temp_sample_1',
            testDate: getLocalDateStr(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)),
            canteen: '一食堂',
            vegetable: '青菜',
            testItem: '克百威-胶体金检测卡',
            result: '合格',
            inspector: '检测员C'
        },
        {
            id: 'temp_sample_2',
            testDate: getLocalDateStr(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)),
            canteen: '二食堂',
            vegetable: '黄瓜',
            testItem: '克百威-胶体金检测卡',
            result: '合格',
            inspector: '检测员D'
        },
        {
            id: 'temp_sample_3',
            testDate: getLocalDateStr(new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)),
            canteen: '一食堂',
            vegetable: '番茄',
            testItem: '克百威-胶体金检测卡',
            result: '不合格',
            inspector: '检测员C'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({ data: sampleData.map(r => withCustomFields('pesticide', r)) }));
    console.log('✅ 初始化果蔬农残示例数据:', sampleData.length, '条');
}

/**
 * 初始化食用油品质检测示例数据
 */
function initOil() {
    const storageKey = scopedCacheKey('oil'); // P3-CONS-T01：作用域键（原 'cache_oil'）

    // P1-22: 示例数据 ID 改用 temp_sample_{n}，兼容 StorageService._isTempId() 规则避免同步时被丢弃
    const sampleData = [
        {
            id: 'temp_sample_1',
            testDate: getLocalDateStr(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)),
            canteen: '一食堂',
            inspector: '检测员E',
            oilTemp: 180,
            oilColor: '浅黄色',
            qualityLevel: '合格',
            oilPolarValue: 15.5,
            performanceRating: '合格'
        },
        {
            id: 'temp_sample_2',
            testDate: getLocalDateStr(new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)),
            canteen: '二食堂',
            inspector: '检测员F',
            oilTemp: 195,
            oilColor: '淡黄色',
            qualityLevel: '合格',
            oilPolarValue: 22.3,
            performanceRating: '合格'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({ data: sampleData.map(r => withCustomFields('oil', r)) }));
    console.log('✅ 初始化食用油品质示例数据:', sampleData.length, '条');
}

/**
 * 初始化肉、蛋农残检测示例数据
 */
function initMeat() {
    const storageKey = scopedCacheKey('leanMeat'); // P3-CONS-T01：作用域键（原 'cache_leanMeat'）

    // P1-22: 示例数据 ID 改用 temp_sample_{n}，兼容 StorageService._isTempId() 规则避免同步时被丢弃
    const sampleData = [
        {
            id: 'temp_sample_1',
            testDate: getLocalDateStr(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)),
            canteen: '一食堂',
            meatType: '猪肉',
            testItem: '恩诺沙星-胶体金检测卡',
            result: '合格',
            inspector: '检测员G'
        },
        {
            id: 'temp_sample_2',
            testDate: getLocalDateStr(new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)),
            canteen: '二食堂',
            meatType: '鸡蛋',
            testItem: '恩诺沙星-胶体金检测卡',
            result: '合格',
            inspector: '检测员H'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({ data: sampleData.map(r => withCustomFields('leanMeat', r)) }));
    console.log('✅ 初始化肉、蛋农残示例数据:', sampleData.length, '条');
}

/**
 * 初始化病原体检测示例数据
 */
function initPathogen() {
    const storageKey = scopedCacheKey('pathogen'); // P3-CONS-T01：作用域键（原 'cache_pathogen'）

    // P1-22: 示例数据 ID 改用 temp_sample_{n}，兼容 StorageService._isTempId() 规则避免同步时被丢弃
    const sampleData = [
        {
            id: 'temp_sample_1',
            testDate: getLocalDateStr(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)),
            sampleId: 'S001',
            canteen: '一食堂',
            pathogenType: '沙门氏菌',
            positiveItem: '无',
            riskLevel: '低',
            inspector: '检测员I'
        },
        {
            id: 'temp_sample_2',
            testDate: getLocalDateStr(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)),
            sampleId: 'S002',
            canteen: '二食堂',
            pathogenType: '李斯特菌',
            positiveItem: '无',
            riskLevel: '低',
            inspector: '检测员J'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({ data: sampleData.map(r => withCustomFields('pathogen', r)) }));
    console.log('✅ 初始化病原体检测示例数据:', sampleData.length, '条');
}

// TD-P2-24: 移除死代码 initDashboard() — 该函数从未被调用（L55 已注释），
// 且引用的 window.loadDashboardData 已被 P1-20 移除；initializeSampleData() 已自行 dispatch dataChanged 事件
