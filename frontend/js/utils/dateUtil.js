// js/utils/dateUtil.js
// CR-13 / CR-14：统一日期与「按天边界」处理，避免跨时区日期差一天、跨天统计错位。
// 所有展示/分组一律以【本地时区】的 YYYY-MM-DD 为准，禁止再用 toISOString().split('T')[0]。

/** 当前时间（集中出口，便于测试注入） */
export function getNow() {
    return new Date();
}

function _toDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'string' || typeof v === 'number') {
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}

/** 本地时区的 YYYY-MM-DD（CR-13：规避 toISOString 的 UTC 偏移） */
export function getLocalDateStr(date = new Date()) {
    const d = _toDate(date);
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** 本地时区的 YYYY-MM（用于「按月」筛选/统计的默认值） */
export function getLocalMonthStr(date = new Date()) {
    const d = _toDate(date);
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/** 本地时区某天的起始时刻 00:00:00.000（CR-14：按天分桶左边界） */
export function startOfLocalDay(date = new Date()) {
    const d = _toDate(date) || new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

/** 本地时区某天的结束时刻 23:59:59.999（CR-14：按天分桶右边界，含当日午夜前） */
export function endOfLocalDay(date = new Date()) {
    const d = _toDate(date) || new Date();
    d.setHours(23, 59, 59, 999);
    return d;
}

/** 按本地时区分组的 key（YYYY-MM-DD），用于统计聚合 */
export function dayKey(date) {
    return getLocalDateStr(date);
}

/** 判断记录日期是否落在 [start, end] 本地时区区间内（含边界） */
export function isWithinLocalDayRange(date, start, end) {
    const d = _toDate(date);
    if (!d) return false;
    const s = start instanceof Date ? start : startOfLocalDay(start);
    const e = end instanceof Date ? end : endOfLocalDay(end);
    return d.getTime() >= s.getTime() && d.getTime() <= e.getTime();
}
