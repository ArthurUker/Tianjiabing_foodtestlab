# FIX-P2-04：AuthService.getUser() JSON.parse 无容错处理

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-04` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/services/AuthService.js` |
| **预估工时** | 0.5h |
| **关联问题** | P2-11（同族 GuestAuthService JSON.parse 容错） |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`AuthService.getUser()` 直接 `JSON.parse(localStorage.getItem('current_user'))`，若 localStorage 中 `current_user` 因异常写入或手动篡改导致格式损坏（非合法 JSON），`JSON.parse` 抛出 `SyntaxError`，未被捕获，导致调用方崩溃。

## 2. 根因分析

`js/services/AuthService.js` 的 `getUser()`（原 L219）：
```javascript
return JSON.parse(userStr);  // 无 try/catch，损坏数据导致抛异常
```
localStorage 为客户端可任意修改的存储，数据损坏属可预见场景，缺少防御性编程。

## 3. 修复方案（2026-07-04 实施）

包裹 try/catch，损坏时清除脏数据并返回 null：

```javascript
getUser() {
    const userStr = localStorage.getItem(this.userKey);
    if (!userStr) return null;
    try {
        return JSON.parse(userStr);
    } catch (e) {
        console.error('❌ current_user 解析失败，清除损坏数据:', e.message);
        localStorage.removeItem(this.userKey);
        return null;
    }
}
```

## 4. 验收标准

- [x] `current_user` 为合法 JSON → 正常返回用户对象
- [x] `current_user` 为损坏字符串 → 不抛异常，清除该 key，返回 null
- [x] `current_user` 不存在 → 返回 null（原逻辑保留）
- [x] 静态验证通过；运行时验证为前端行为，未单独执行

## 5. 回归测试要点

- [ ] 手动在 localStorage 写入 `current_user = '{bad json'`，调用 `getUser()` 不崩溃且清除了脏数据

## 6. 备注

- 同族问题 P2-11（`GuestAuthService.getCurrentGuest()`）采用相同方案修复。
