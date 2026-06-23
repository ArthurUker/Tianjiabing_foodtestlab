> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§1.10 GitHub CDN 缓存解决方案 + 工作流规范
> **最后更新**：v0.10（2026-06-23）

---

### 1.10 GitHub 文件读取 CDN 缓存问题与解决方案（v0.10 新增）

> **问题背景**：`raw.githubusercontent.com` 通过 Fastly CDN 分发文件，缓存 TTL 不固定（通常 5 分钟，高负载时更长）。在 `git push` 后立即读取，AI 可能仍拿到旧版本缓存内容，导致核验结论基于过期数据。

> **解决方案**：在所有 `raw.githubusercontent.com` 链接末尾追加时间戳参数 `?t={unix_timestamp}`，CDN 将其视为全新请求，强制回源拉取最新内容。

**标准读取 URL 格式：**

```
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/{文件路径}?t={当前Unix时间戳}
```

**示例：**
```
# 旧方式（受 CDN 缓存影响，可能读到旧版本）
https://raw.githubusercontent.com/.../FIX_PLAN.md

# 新方式（强制绕过缓存，始终读取最新版本）
https://raw.githubusercontent.com/.../FIX_PLAN.md?t=1750669200
```

> **执行规则**：Monica 在每次新对话中读取任何 GitHub 文件时，自动附加当前时间戳参数，无需郭博额外操作。时间戳每次不同即可，无需精确对应当前时刻。

---

## 5. 待审阅文件与下一步任务

### 5.1 下一轮建议任务（核心文件已全覆盖）

核心业务文件已全部审阅完毕（覆盖率 ~95%）。`guest.html` 已确认不存在。下一轮可聚焦以下方向：

```
# 1. 工程配置文件（优先级低，可选）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/.babelrc
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/webpack.config.js

# 2. 转入修复阶段：按 P0 → P1 → P2 优先级逐项输出修复方案
```

### 5.2 建议转入修复方案输出阶段

> 核心文件审阅已基本完成（覆盖率 ~95%）。建议下一步转入**修复方案输出**阶段：
>
> - 按 P0 → P1 → P2 优先级，逐项输出具体代码修复方案
> - 每次对话选取 3~5 个问题，提供可直接应用的代码 diff
> - 修复完成后在本文档对应条目标记 `✅ 已修复`

### 5.3 审阅维度清单（每轮对话参考）

| 维度 | 检查要点 |
|------|----------|
| **安全性** | 输入验证、XSS/SQL注入防护、权限校验、Token 存储方式 |
| **一致性** | 接口契约与前端调用是否匹配、字段命名统一性 |
| **健壮性** | 错误处理完整性、边界条件、JSON 解析容错 |
| **可维护性** | 代码重复度、模块职责单一性、注释完整性 |
| **性能** | 数据库查询效率、N+1 问题、缓存策略 |
| **合规性** | 审计日志完整性、数据删除策略、食品安全记录保留要求 |

---

## 6. 每次新对话的接续指令模板

> 在新对话开始时，将本文件内容粘贴给 AI，并附加以下指令：

```
我正在对食品安全检验管理系统进行代码审阅。
仓库地址：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
本次审阅上下文见 docs/review/REVIEW_GUIDE.md（请先读取 GitHub 上的最新版本）。

本轮任务：
1. 首先读取 GitHub 上的 REVIEW_GUIDE.md 确认版本号
2. 读取"第5.1节-待审阅文件"中的下一批文件（使用 raw.githubusercontent.com 链接）
3. 按"第5.3节-审阅维度清单"进行分析
4. 将新发现的问题追加到本文档"第3节-已发现问题清单"中
5. 更新"第2节-已审阅文件清单"的状态
6. 输出更新后的完整 REVIEW_GUIDE.md
```
