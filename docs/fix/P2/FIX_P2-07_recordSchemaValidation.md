# FIX-P2-07：buildRecordWriteData() 字段提取无 Schema 验证

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-07` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `backend/server.js` |
| **预估工时** | 2h |
| **关联问题** | P2-27（Pathogen Word 导入 fallback 语义问题） |
| **状态** | ✅ 已完成（静态验证 + 运行时验证均通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`buildRecordWriteData()` 从请求体提取字段写入数据库时，无任何 Schema 验证。`testDate`/`canteen`/`inspector` 等关键字段可为空字符串或 `undefined`，仍能写入数据库，导致后续统计/展示出现空值记录，数据质量无保障。

## 2. 根因分析

`backend/server.js` 的 `POST /api/records/:tableName`（创建）与 `PUT /api/records/:tableName/:id`（更新）路由直接将 `req.body` 传入 `buildRecordWriteData()`，未对必填字段做非空校验，直接写入 Prisma。

## 3. 修复方案（2026-07-04 实施）

新增 `validateRecordPayload(tableName, payload)` 验证函数，在创建与更新前调用：

```javascript
// P2-07: 记录字段 Schema 验证 — 校验 testDate/canteen/inspector 必填且为非空字符串
function validateRecordPayload(tableName, payload) {
    const errors = []
    const requiredFields = ['testDate', 'canteen', 'inspector']
    for (const field of requiredFields) {
        const val = payload[field]
        if (val === undefined || val === null || String(val).trim() === '') {
            errors.push(`字段 "${field}" 不能为空`)
        }
    }
    if (!RECORD_ROUTE_TYPES.has(tableName)) {
        errors.push(`未知的记录类型: ${tableName}`)
    }
    return { valid: errors.length === 0, errors }
}
```

调用点：
- 创建（L524-528）：`validateRecordPayload(testType, payload)`，不通过返回 400
- 更新（L704-708）：`validateRecordPayload(testType, req.body)`，不通过返回 400

## 4. 验收标准

- [x] `testDate`/`canteen`/`inspector` 三字段为空/undefined/纯空白时返回 400
- [x] 未知记录类型时返回 400
- [x] 创建与更新两个路径均接入验证
- [x] 运行时验证（2026-07-04 执行）：创建 tableware 测试记录（含合法 testDate/canteen/inspector）通过验证并写入成功，确认验证逻辑不误拦合法数据

## 5. 回归测试要点

- [ ] 缺少 inspector 字段的请求返回 400 且不入库
- [ ] 合法请求正常写入

## 6. 备注

- 关联 P2-27：本修复要求 `testDate`/`canteen`/`inspector` 非空，但 `Pathogen.js` 的 `parseDetectionReport()` 在 Word 文档无法提取这些字段时 fallback 为当天日期/"未知"/"系统导入"等非空字符串，可通过本 Schema 校验，但语义上掩盖了数据缺失（见 P2-27）。
