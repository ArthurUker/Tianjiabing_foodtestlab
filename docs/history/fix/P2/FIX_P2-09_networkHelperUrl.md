# FIX-P2-09：NetworkHelper 硬编码 Google URL，内网环境不可达

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-09` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/utils/NetworkHelper.js` |
| **预估工时** | 0.5h |
| **关联问题** | - |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`NetworkHelper.checkConnection()` 默认探测 `https://www.google.com/favicon.ico` 判断网络连通性。国内/内网环境下 Google 不可达，导致网络状态误判为离线，触发离线模式逻辑，影响数据同步。

## 2. 根因分析

`js/utils/NetworkHelper.js` 的 `checkConnection(url = 'https://www.google.com/favicon.ico')` 将 Google favicon 硬编码为默认探测地址，未考虑部署环境差异。

## 3. 修复方案（2026-07-04 实施）

默认探测地址改为当前站点自身的健康检查端点，调用方可仍传自定义 url：

```javascript
// P2-09: 移除硬编码 Google URL（内网/国内不可达），默认探测当前站点健康检查端点
static async checkConnection(url = '') {
    const checkUrl = url || (typeof window !== 'undefined'
        ? `${window.location.origin}/api/health`
        : '/api/health')
    try {
        const response = await this.fetchWithTimeout(checkUrl, { timeout: 5000 })
        return response.ok
    } catch (error) {
        console.warn('网络连接检查失败:', error.message)
        return false
    }
}
```

## 4. 验收标准

- [x] 默认探测地址为 `${origin}/api/health`，不再硬编码 Google
- [x] 调用方传入自定义 url 时仍使用自定义地址
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] 内网环境下网络检查返回在线（后端可达即在线）
- [ ] 传入自定义 url 时按自定义地址探测

## 6. 备注

> 无。
