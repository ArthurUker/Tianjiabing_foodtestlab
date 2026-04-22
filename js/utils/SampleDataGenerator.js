/**
 * 示例数据生成器
 * 为快速访问模式生成示例检测数据
 */

export function initializeSampleData() {
    // 检查是否是快速访问模式
    const urlParams = new URLSearchParams(window.location.search);
    const isQuickAccess = urlParams.get('quickAccess') === 'true';
    
    if (!isQuickAccess) return;
    
    console.log('📊 初始化示例数据用于快速访问模式...');
    
    // ✨ 注意：不清除缓存，因为可能已有真实数据。只在必要时添加缺失的数据
    // const keysToRemove = [];
    // for (let i = 0; i < localStorage.length; i++) {
    //     const key = localStorage.key(i);
    //     if (key && (key.startsWith('cache_') || key.startsWith('pending_'))) {
    //         keysToRemove.push(key);
    //     }
    // }
    // keysToRemove.forEach(key => localStorage.removeItem(key));
    // console.log(`🧹 已清除 ${keysToRemove.length} 个缓存键`);
    
    // ✨ 只初始化缺失的数据，保留现有数据
    const existingKeys = new Set();
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('cache_')) {
            existingKeys.add(key);
        }
    }
    
    // 只初始化缺失的缓存
    if (!existingKeys.has('cache_tableware')) {
        console.log('📊 初始化缺失的餐具洁净度数据...');
        initTableware();
    } else {
        console.log('✅ 缓存已存在，跳过初始化餐具洁净度数据');
    }
    
    if (!existingKeys.has('cache_pesticide')) initPesticide();
    else console.log('✅ 缓存已存在，跳过初始化果蔬农残数据');
    
    if (!existingKeys.has('cache_oil')) initOil();
    else console.log('✅ 缓存已存在，跳过初始化食用油品质数据');
    
    if (!existingKeys.has('cache_leanMeat')) initMeat();
    else console.log('✅ 缓存已存在，跳过初始化瘦肉精数据');
    
    if (!existingKeys.has('cache_pathogen')) initPathogen();
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
    const storageKey = 'cache_tableware';
    
    const sampleData = [
        {
            id: 1,
            testDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '一食堂',
            inspector: '检测员A',
            atpPoints: [
                { loc: '餐具表面', rluValue: 150, result: '合格' },
                { loc: '操作台', rluValue: 320, result: '警戒' }
            ],
            finalStatus: '合格'
        },
        {
            id: 2,
            testDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '二食堂',
            inspector: '检测员B',
            atpPoints: [
                { loc: '盘子表面', rluValue: 100, result: '合格' },
                { loc: '锅具', rluValue: 250, result: '警戒' }
            ],
            finalStatus: '合格'
        },
        {
            id: 3,
            testDate: new Date().toISOString().split('T')[0],
            canteen: '一食堂',
            inspector: '检测员A',
            atpPoints: [
                { loc: '餐具表面', rluValue: 50, result: '合格' }
            ],
            finalStatus: '合格'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({data: sampleData}));
    console.log('✅ 初始化餐具洁净度示例数据:', sampleData.length, '条');
}

/**
 * 初始化果蔬农残检测示例数据
 */
function initPesticide() {
    const storageKey = 'cache_pesticide';
    
    const sampleData = [
        {
            id: 1,
            testDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '一食堂',
            vegetable: '青菜',
            testItem: '克百威-胶体金检测卡',
            result: '合格',
            inspector: '检测员C'
        },
        {
            id: 2,
            testDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '二食堂',
            vegetable: '黄瓜',
            testItem: '克百威-胶体金检测卡',
            result: '合格',
            inspector: '检测员D'
        },
        {
            id: 3,
            testDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '一食堂',
            vegetable: '番茄',
            testItem: '克百威-胶体金检测卡',
            result: '不合格',
            inspector: '检测员C'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({data: sampleData}));
    console.log('✅ 初始化果蔬农残示例数据:', sampleData.length, '条');
}

/**
 * 初始化食用油品质检测示例数据
 */
function initOil() {
    const storageKey = 'cache_oil';
    
    const sampleData = [
        {
            id: 1,
            testDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '一食堂',
            inspector: '检测员E',
            oilTemp: 180,
            oilColor: '浅黄色',
            qualityLevel: '合格',
            oilPolarValue: 15.5,
            performanceRating: '合格'
        },
        {
            id: 2,
            testDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '二食堂',
            inspector: '检测员F',
            oilTemp: 195,
            oilColor: '淡黄色',
            qualityLevel: '合格',
            oilPolarValue: 22.3,
            performanceRating: '合格'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({data: sampleData}));
    console.log('✅ 初始化食用油品质示例数据:', sampleData.length, '条');
}

/**
 * 初始化肉、蛋农残检测示例数据
 */
function initMeat() {
    const storageKey = 'cache_leanMeat';
    
    const sampleData = [
        {
            id: 1,
            testDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '一食堂',
            meatType: '猪肉',
            testItem: '恩诺沙星-胶体金检测卡',
            result: '合格',
            inspector: '检测员G'
        },
        {
            id: 2,
            testDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            canteen: '二食堂',
            meatType: '鸡蛋',
            testItem: '恩诺沙星-胶体金检测卡',
            result: '合格',
            inspector: '检测员H'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({data: sampleData}));
    console.log('✅ 初始化肉、蛋农残示例数据:', sampleData.length, '条');
}

/**
 * 初始化病原体检测示例数据
 */
function initPathogen() {
    const storageKey = 'cache_pathogen';
    
    const sampleData = [
        {
            id: 1,
            testDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            sampleId: 'S001',
            canteen: '一食堂',
            pathogenType: '沙门氏菌',
            positiveItem: '无',
            riskLevel: '低',
            inspector: '检测员I'
        },
        {
            id: 2,
            testDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            sampleId: 'S002',
            canteen: '二食堂',
            pathogenType: '李斯特菌',
            positiveItem: '无',
            riskLevel: '低',
            inspector: '检测员J'
        }
    ];
    
    localStorage.setItem(storageKey, JSON.stringify({data: sampleData}));
    console.log('✅ 初始化病原体检测示例数据:', sampleData.length, '条');
}

/**
 * 初始化仪表板统计
 */
function initDashboard() {
    // 数据看板的统计数据会从各个模块的数据中计算，不需要单独初始化
    console.log('✅ 数据看板将自动计算统计数据');
    
    // 强制刷新Dashboard数据（延迟以确保所有数据都已加载）
    setTimeout(() => {
        try {
            const loadDashboardDataFn = window.loadDashboardData;
            if (typeof loadDashboardDataFn === 'function') {
                console.log('🔄 强制刷新Dashboard数据...');
                loadDashboardDataFn();
            }
        } catch (e) {
            console.log('📌 Dashboard尚未初始化或无法直接调用loadDashboardData');
        }
        
        // 尝试通过事件触发
        try {
            document.dispatchEvent(new Event('dataChanged'));
            console.log('📡 已发送dataChanged事件');
        } catch (e) {
            console.log('⚠️ 事件发送失败:', e);
        }
    }, 300);
}
