// 病原体阳性识别与风险评估通用算法

export function isPositiveResult(result) {
    if (!result) return false;
    const s = String(result).trim();
    return s.includes('阳性') || s === '+' || s === '(+)' || s === '＋';
}

function normalizePositiveList(positiveList) {
    if (!Array.isArray(positiveList)) return [];

    return positiveList.map(item => {
        const ctRaw = item?.ctRaw ?? item?.ct ?? '-';
        const ct = parseFloat(item?.ct ?? item?.ctRaw);
        return {
            pathogen: item?.pathogen || '未知靶标',
            ct: Number.isFinite(ct) ? ct : 999,
            ctRaw: ctRaw
        };
    });
}

function extractPositiveListFromAllTestItems(allTestItems) {
    if (!Array.isArray(allTestItems) || allTestItems.length === 0) return [];

    return allTestItems
        .filter(item => item && item.result && isPositiveResult(item.result) && !item.isInternalControl)
        .map(item => {
            const ctRaw = item.ctRaw ?? item.ct ?? '-';
            const ct = parseFloat(item.ct ?? item.ctRaw);
            return {
                pathogen: item.pathogen || '未知靶标',
                ct: Number.isFinite(ct) ? ct : 999,
                ctRaw: ctRaw
            };
        });
}

export function calculatePathogenRisk(positiveList = [], allTestItems = []) {
    let validPositiveList = normalizePositiveList(positiveList);

    const extracted = extractPositiveListFromAllTestItems(allTestItems);
    if (extracted.length > 0) {
        validPositiveList = extracted;
    }

    if (validPositiveList.length === 0) {
        return {
            riskLevel: '无风险',
            riskReason: '所有检测项均为阴性',
            riskInterpretation: '所有检测项均为阴性',
            positiveItemsDisplay: '无',
            positiveDetails: [],
            minCt: null
        };
    }

    const minCt = Math.min(...validPositiveList.map(p => p.ct));

    let riskLevel = '未知';
    let riskInterpretation = '';

    if (minCt < 20) {
        riskLevel = '高风险';
        riskInterpretation = '病原体载量高，提示可能存在活性感染源，需立即处置';
    } else if (minCt >= 20 && minCt < 30) {
        riskLevel = '中风险';
        riskInterpretation = '检出中等载量病原体核酸，建议加强清洁消毒';
    } else if (minCt >= 30 && minCt < 35) {
        riskLevel = '低风险';
        riskInterpretation = '检出低载量病原体核酸，可能为环境残留，建议常规消毒';
    } else {
        riskLevel = '极低风险';
        riskInterpretation = '仅检出微量核酸片段，通常为环境残留或非活性核酸，无需特殊处置（参考：Kitajima et al., 2012）';
    }

    const positiveItemsDisplay = validPositiveList
        .map(p => `${p.pathogen}(Ct:${p.ctRaw})`)
        .join(', ');

    const criticalPathogen = validPositiveList.find(p => p.ct === minCt) || validPositiveList[0];
    const riskReason = `${criticalPathogen.pathogen}，Ct=${criticalPathogen.ctRaw}。${riskInterpretation}`;

    return {
        riskLevel,
        riskReason,
        riskInterpretation,
        positiveItemsDisplay,
        positiveDetails: validPositiveList,
        minCt
    };
}
