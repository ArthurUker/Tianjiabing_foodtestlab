# FIX-P2-14：ExportService 导出数据完全来自本地缓存，可能过期

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-14` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/services/ExportService.js` |
| **预估工时** | 1h |
| **关联问题** | P1-14（Storage.getAll 缓存优先） |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`ExportService` 导出报告时数据完全来自本地缓存（localStorage），不主动从服务器同步。若本地缓存过期（其他终端新增/修改了记录），导出报告将缺失最新数据，产生不准确的结果。

## 2. 根因分析

`js/services/ExportService.js` 导出流程直接读取 `storage[type]` 的本地缓存数据，未在导出前触发服务端同步。与 P1-14（`Storage.getAll()` 优先返回本地缓存）同源问题。

## 3. 修复方案（2026-07-04 实施）

新增 `syncBeforeExport()` 方法，导出前对 5 类记录（tableware/pesticide/oil/leanMeat/pathogen）并发从服务端拉取最新数据并刷新本地缓存：

```javascript
// P2-14: 导出前从服务器同步最新数据，避免使用过期的本地缓存
async syncBeforeExport() {
    const results = {};
    const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
    await Promise.all(types.map(async (type) => {
        try {
            const token = localStorage.getItem('auth_token') || localStorage.getItem('guest_token');
            const response = await fetch(`/api/records/${type}?limit=10000`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            if (response.ok) {
                const data = await response.json();
                if (data.success && Array.isArray(data.data)) {
                    this.storage[type]._updateLocalCache(data.data);
                    results[type] = { success: true, count: data.data.length };
                } else {
                    results[type] = { success: false, fallback: true };
                }
            } else {
                results[type] = { success: false, fallback: true };
            }
        } catch (e) { results[type] = { success: false, fallback: true }; }
    }));
    return results;
}
```

同步失败时降级使用本地缓存（`fallback: true`），不阻断导出。

## 4. 验收标准

- [x] 导出前对 5 类记录发起服务端同步
- [x] 同步成功后刷新本地缓存再导出
- [x] 同步失败时降级使用缓存，不阻断导出
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] 服务端有新数据、本地缓存过期时，导出报告含最新数据
- [ ] 离线时导出仍可用（降级缓存）

## 6. 备注

- 与 P1-14 互补：P1-14 提供 `getAllFresh()` 强制同步接口，P2-14 在导出场景主动调用同步。
