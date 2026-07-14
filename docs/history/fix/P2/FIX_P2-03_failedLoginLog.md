# FIX-P2-03：失败登录日志未确认写入数据库

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-03` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `backend/modules/UserManager.js` |
| **预估工时** | 0.5h |
| **关联问题** | P2-02（CRUD 审计日志） |
| **状态** | ✅ 已完成（静态验证 + 运行时验证均通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

登录失败时未将失败事件持久化到数据库，无法事后审计暴力破解尝试。`UserManager.loginUser()` 在密码错误时仅抛出错误，不记录失败日志。

## 2. 根因分析

`backend/modules/UserManager.js` 的 `loginUser()`（L98-152）在用户不存在或密码不匹配时直接 `throw new Error`，无任何日志写入调用。安全审计要求失败登录应留痕，以便追踪异常登录行为。

## 3. 修复方案（2026-07-04 实施）

新增 `logFailedLogin(userId, username)` 方法，在两处失败路径调用：

```javascript
async logFailedLogin(userId, username) {
    try {
        // P2-03: userId 为 null 时（用户不存在），AuditLog 需有效 user_id 外键无法写入，改记 SystemLog
        if (!userId) {
            await this.prisma.systemLog.create({
                data: {
                    level: 'warn',
                    message: `登录失败（用户不存在）: ${username}`,
                    context: JSON.stringify({ username, timestamp: new Date().toISOString() })
                }
            })
            return
        }
        await this.prisma.auditLog.create({
            data: {
                user_id: userId,
                action: 'login_failed',
                details: JSON.stringify({ username, timestamp: new Date().toISOString() })
            }
        })
    } catch (error) {
        console.error(`❌ 记录失败登录失败: ${error.message}`)
    }
}
```

调用点（`loginUser` 内）：
- 用户不存在（L107）：`await this.logFailedLogin(null, username)` → 写入 `SystemLog`（因 AuditLog.user_id 外键约束）
- 密码不匹配（L121）：`await this.logFailedLogin(user.id, username)` → 写入 `AuditLog` action=`login_failed`

## 4. 验收标准

- [x] 用户不存在时失败登录写入 `SystemLog`（level=warn）
- [x] 密码错误时失败登录写入 `AuditLog`（action=login_failed）
- [x] 日志写入失败不阻断登录失败响应（try/catch 降级）
- [x] 运行时验证（2026-07-04 执行）：对 admin 账号发起 10 次错误密码登录，AuditLog 产生 10 条 `action=login_failed` 记录（admin 用户存在，走 AuditLog 路径）。该 10 条日志已在本次环境清理中删除（见本轮子任务二）

## 5. 回归测试要点

- [ ] 不存在的用户名登录失败 → SystemLog 新增 warn 记录
- [ ] 存在的用户密码错误 → AuditLog 新增 login_failed 记录

## 6. 备注

- userId 为 null 时改用 SystemLog，因 AuditLog.user_id 为外键（引用 User.id，onDelete: Cascade），无法写入 null。
- 运行时验证产生的 10 条 login_failed 日志已在本轮子任务二清理。
