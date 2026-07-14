# FIX-P1-24：AdaptiveUploadQueue._doRequest() URL 硬编码，绕过 StorageService 的 apiBaseUrl 配置

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-24` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/core/AdaptiveUploadQueue.js`, `js/core/Storage.js` |
| **预估工时** | 1h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01 |

---

## 1. 问题

> 来自 FIX_PLAN.md P1-24 原始描述：
> AdaptiveUploadQueue._doRequest() URL 硬编码，绕过 StorageService 的 apiBaseUrl 配置

> 来自 RG_03b_ISSUES_P1.md §3 P1-24 审阅细化：
> - **位置**：`js/core/AdaptiveUploadQueue.js`，`_doRequest()` 方法
> - **问题**：`_doRequest()` 中所有请求 URL 均硬编码为 `/api/records/${item.collection}`，完全忽略 `StorageService` 构造时通过 `getHeaders` 回调传入的 `apiBaseUrl` 配置；若未来 API 前缀变更或需要多环境部署，`AdaptiveUploadQueue` 的请求将无法跟随配置变更
> - **修复建议**：在 `AdaptiveUploadQueue` 构造函数中新增 `getBaseUrl` 回调选项，`StorageService` 初始化时传入 `() => this.apiBaseUrl`；`_doRequest()` 改为 `` `${this._getBaseUrl()}/${item.collection}` ``

## 2. 根因

`AdaptiveUploadQueue` 构造函数仅接收 `getHeaders` 回调用于注入认证头，未提供任何获取 API 基础 URL 的通道。`_doRequest()` 方法在构造 POST/PUT/DELETE/fallback 四类请求 URL 时，将前缀 `/api/records/` 直接硬编码为字面量，导致：

- `StorageService` 构造时通过 `config.apiBaseUrl`（默认 `/api/records`）建立的 API 端点配置无法传递到上传队列
- 若未来 `apiBaseUrl` 配置变更（如 API 版本前缀调整 `/api/v2/records` 或多环境部署自定义前缀），`AdaptiveUploadQueue` 的请求仍会走旧前缀，与 `StorageService._syncFromApi()`（使用 `this.apiEndpoint`）请求路径不一致

`AdaptiveUploadQueue` 唯一消费方为 `js/core/Storage.js`（第 4 行 import、第 68 行实例化），无其他外部调用方，修复影响面可控。

## 3. 修复

按 RG_03b 审阅建议，最小改动两处：

**① `js/core/AdaptiveUploadQueue.js` 构造函数新增 `getBaseUrl` 回调（第 36-37 行）：**

```javascript
// P1-24: 新增 getBaseUrl 回调，避免 _doRequest() 硬编码 /api/records 前缀
this._getBaseUrl = options.getBaseUrl ?? (() => '/api/records');
```

默认回调返回 `/api/records`，与原硬编码值一致，保证未传入回调时行为向后兼容。

**② `js/core/AdaptiveUploadQueue.js` `_doRequest()` URL 前缀改用回调（第 208-218 行）：**

```javascript
// P1-24: URL 前缀改用 getBaseUrl 回调，跟随 StorageService.apiBaseUrl 配置
const baseUrl = this._getBaseUrl();
if (method === 'POST') {
  url = `${baseUrl}/${item.collection}`;
} else if (method === 'PUT') {
  url = `${baseUrl}/${item.collection}/${item.recordId}`;
} else if (method === 'DELETE') {
  url = `${baseUrl}/${item.collection}/${item.recordId}`;
} else {
  url = `${baseUrl}/${item.collection}/${item.recordId || ''}`;
}
```

**③ `js/core/Storage.js` 实例化时传入回调（第 74-75 行）：**

```javascript
// P1-24: 传入 apiBaseUrl 回调，使队列请求跟随 StorageService 配置
getBaseUrl: () => this.apiBaseUrl,
```

`StorageService.apiBaseUrl` 默认 `/api/records`，拼接后 URL 与原硬编码完全一致，行为零变化。

## 4. 功能影响

- 默认配置下（`apiBaseUrl = '/api/records'`），`_doRequest()` 生成的 POST/PUT/DELETE URL 与修复前完全一致，运行时行为零变化
- 修复后，若 `StorageService` 构造时传入自定义 `apiBaseUrl`（如 `/api/v2/records`），上传队列请求将自动跟随，与 `_syncFromApi()` 的 `this.apiEndpoint` 路径保持一致
- `AdaptiveUploadQueue` 向后兼容：未传入 `getBaseUrl` 时默认返回 `/api/records`，不影响潜在的其他实例化方
- 唯一消费方 `StorageService` 已同步传入回调，无遗漏调用方

## 5. 验收标准

- [x] `AdaptiveUploadQueue` 构造函数接收 `getBaseUrl` 选项，默认回调返回 `/api/records`
- [x] `_doRequest()` 四类 URL（POST/PUT/DELETE/fallback）均使用 `${this._getBaseUrl()}/` 前缀，无 `/api/records/` 字面量残留
- [x] `StorageService` 实例化 `AdaptiveUploadQueue` 时传入 `getBaseUrl: () => this.apiBaseUrl`
- [x] 默认配置下拼接结果与原硬编码一致（`/api/records/${collection}` 等）
- [x] git diff 仅涉及 `js/core/AdaptiveUploadQueue.js` 与 `js/core/Storage.js` 两个文件

## 6. 回归测试要点

- [ ] 前端检测记录新增（POST）行为不变，请求命中 `POST /api/records/:tableName`
- [ ] 前端检测记录编辑（PUT）行为不变，请求命中 `PUT /api/records/:tableName/:id`
- [ ] 前端检测记录删除（DELETE）行为不变，请求命中 `DELETE /api/records/:tableName/:id`
- [ ] 409 冲突恢复路径 `_fetchLatest()` 仍走原硬编码（本次未修，见技术债 TD-P2-28）

## 7. 技术债

- **TD-P2-28**：`AdaptiveUploadQueue._fetchLatest()`（`js/core/AdaptiveUploadQueue.js:235-240`）在 409 版本冲突恢复路径中被调用，其 URL 同样硬编码 `/api/records/${collection}/${recordId}`，未跟随 `getBaseUrl` 回调。本次修复严格按 RG_03b 明确范围仅修复 `_doRequest()`，`_fetchLatest()` 属同类问题但不在审阅建议明确点名范围内。后续应将 `_fetchLatest()` 一并迁移至 `this._getBaseUrl()`，保证队列内所有请求 URL 来源统一。

## 8. 备注

- 代码提交：`2a229a3`（fix(P1-24): AdaptiveUploadQueue._doRequest() URL改用getBaseUrl回调跟随apiBaseUrl）
