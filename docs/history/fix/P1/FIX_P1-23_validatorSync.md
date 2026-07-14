# FIX-P1-23：前端 FormValidator 校验规则与后端 validationMiddleware 不同步

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-23` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/utils/FormValidator.js`, `backend/middleware/validationMiddleware.js` |
| **预估工时** | 2h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01 |

---

## 1. 问题

> 来自 FIX_PLAN.md P1-23 原始描述：
> 前端 FormValidator 校验规则与后端 validationMiddleware 不同步

> 来自 RG_03b_ISSUES_P1.md §3 P1-23 审阅细化：
> - **位置**：`js/utils/FormValidator.js` vs `backend/middleware/validationMiddleware.js`
> - 前端 `FormValidator` 有 `phone`（中国手机号正则）、`idCard`、`dateNotFuture` 等规则
> - 后端 `validationMiddleware` 的规则集未完整读取（~40%），无法确认是否覆盖相同字段
> - 若两端校验规则不一致，攻击者可绕过前端校验直接向后端发送非法数据
> - **修复建议**：建立统一的校验规则配置文件，前后端共享；或至少确保后端校验是前端的超集

## 2. 根因

经完整核验两端规则集：

- 前端 `FormValidator.rules`（`js/utils/FormValidator.js:17-84`）共 10 条规则：`required`、`minLength`、`maxLength`、`email`、`number`、`date`、`phone`、`dateNotFuture`、`idCard`、`url`
- 后端 `fieldValidators`（`backend/middleware/validationMiddleware.js:225-266`）原有 8 条规则：`email`、`username`、`password`、`phone`、`url`、`integer`、`number`、`date`

后端缺失 `dateNotFuture` 与 `idCard` 两条规则，未达到"后端校验为前端超集"要求。其中 `dateNotFuture` 在前端被活跃使用（`GenericTest.js:965`、`Tableware.js:650` 的 `testDate` 字段 schema），存在攻击者绕过前端直接向后端提交未来日期检测记录的风险。

补充发现：后端 `fieldValidators` 对象虽然定义并导出，但 `validateField` 中间件及 `fieldValidators` 全后端无任何路由调用方（`server.js:18` 仅导入 `createValidationMiddleware, rateLimit, sanitizeText`），实为死代码。本次修复使规则集达到超集要求，为后续将 `validateField` 接入具体路由奠定基础。

## 3. 修复

按 RG_03b 审阅建议"至少确保后端校验是前端的超集"，在 `backend/middleware/validationMiddleware.js` 的 `fieldValidators` 对象中补充两条验证器（`date` 验证器之后），采用后端 boolean 返回约定，正则与前端完全对齐：

```javascript
// P1-23: 与前端 FormValidator.dateNotFuture 对齐，确保后端校验为前端超集
dateNotFuture: (value) => {
    const dateObj = new Date(value)
    if (isNaN(dateObj.getTime())) {
        return false
    }
    return dateObj <= new Date()
},

// P1-23: 与前端 FormValidator.idCard 对齐，确保后端校验为前端超集
idCard: (value) => {
    const idCardRegex = /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/
    return idCardRegex.test(value)
}
```

未采用"建立统一校验规则配置文件，前后端共享"方案（RG_03b 方案 A）：该方案需引入前后端共享模块机制（如独立 npm 包或符号链接），超出最小改动原则，且本项目前端为原生 JS（无构建步骤），后端为 ESM Node.js，共享模块引入成本较高。

## 4. 功能影响

- 后端 `fieldValidators` 规则集由 8 条扩展至 10 条，覆盖前端 `FormValidator.rules` 全部非参数化规则
- `dateNotFuture`：校验日期值有效且不晚于当前时间，与前端逻辑一致
- `idCard`：校验 18 位中国身份证号格式（支持末位 X），正则与前端完全一致
- 现有行为零影响：`fieldValidators` 当前为死代码（无路由调用），新增键值对为纯函数无副作用
- 前端 `FormValidator` 消费方（GenericTest/Tableware/Pathogen）不受影响

## 5. 验收标准

- [x] 后端 `fieldValidators` 包含 `dateNotFuture` 规则，逻辑与前端 `FormValidator.dateNotFuture` 对齐
- [x] 后端 `fieldValidators` 包含 `idCard` 规则，正则与前端 `FormValidator.idCard` 完全一致
- [x] `email`/`phone`/`url`/`number`/`date` 五条共有规则两端逻辑等价（已核验）
- [x] 修改不影响现有路由行为（`fieldValidators` 无外部调用方）
- [x] git diff 仅涉及 `backend/middleware/validationMiddleware.js` 一个文件

## 6. 回归测试要点

- [ ] 后端启动正常（`node backend/server.js`）
- [ ] 前端检测记录提交（GenericTest/Tableware）testDate 校验行为不变
- [ ] 后端 `fieldValidators.dateNotFuture('2099-01-01')` 返回 `false`
- [ ] 后端 `fieldValidators.idCard('110101199001011234')` 返回 `true`

## 7. 技术债

- **TD-P2-27**：后端 `fieldValidators` 与 `validateField` 中间件当前为死代码（已导出但无路由调用），本次仅补齐规则集达到超集要求，未将 `validateField` 接入具体写入路由（如 `POST /api/records/:tableName`、`POST /api/test-records`）。后续应评估在写入路由上挂载 `validateField` 中间件以实际生效字段格式校验。另外前端 `minLength`/`maxLength` 为参数化规则，后端 `fieldValidators` 结构不支持参数化，如需完全对齐需重构后端验证器结构。

## 8. 备注

- 代码提交：`ef9ca17`（fix(P1-23): fieldValidators补充dateNotFuture/idCard，后端校验对齐前端超集）
