# FIX-P2-11：GuestAuthService.getCurrentGuest() JSON.parse 无容错

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-11` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/services/GuestAuthService.js` |
| **预估工时** | 0.5h |
| **关联问题** | P2-04（同族 AuthService JSON.parse 容错） |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`GuestAuthService.getCurrentGuest()` 直接 `JSON.parse(localStorage.getItem('current_guest'))`，若 `current_guest` 数据损坏，`JSON.parse` 抛出未捕获异常，导致调用方崩溃。

## 2. 根因分析

`js/services/GuestAuthService.js` 的 `getCurrentGuest()`（原 L120）无 try/catch 包裹，与 P2-04 同族问题。

## 3. 修复方案（2026-07-04 实施）

包裹 try/catch，损坏时清除脏数据并返回 null：

```javascript
getCurrentGuest() {
    const guest = localStorage.getItem('current_guest');
    if (!guest) return null;
    try {
        return JSON.parse(guest);
    } catch (e) {
        console.error('❌ current_guest 解析失败，清除损坏数据:', e.message);
        localStorage.removeItem('current_guest');
        return null;
    }
}
```

## 4. 验收标准

- [x] 合法 JSON → 返回访客对象
- [x] 损坏字符串 → 不抛异常，清除 key，返回 null
- [x] 不存在 → 返回 null
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] localStorage 写入损坏 `current_guest`，调用 `getCurrentGuest()` 不崩溃且清除脏数据

## 6. 备注

- 与 P2-04 采用相同修复方案，同属 JSON.parse 容错族。
