# 第三方「重新同步」验收清单（2026-09-17）

> 交付对象：对接方（朴食科技）与验收人。**本清单不由平台主动发送**，由业务方决定沟通时机。
> 前提说明：**服务端的"变化信号"（指纹/摘要变化）与"第三方本地已完成重同步"是两件事** ——
> 平台只能保证信号可被感知，无法证明对方已落库；验收以对方侧证据为准。

## A. 服务端变化信号（平台侧证据，可由平台提供）

| # | 项 | 期望 | 取证方式 |
|---|---|---|---|
| A1 | 当前授权快照 | 学校 / 类型 / `include_inspector` / 授权日期范围 / `scope_version` | `GET /profile` |
| A2 | 投影版本 | `projection_fingerprint`（含**投影实现修订号**与**学校配置指纹**） | `/test-records`、`/samples`、`/sync/manifest` 三处同值 |
| A3 | 清单摘要 | `manifest.digest`（含 `scope_version` + `projection_fingerprint` + `record_code@updated_at`） | `/sync/manifest` |
| A4 | 本次发布后的变化 | 指纹与摘要**相对上次已变化**（投影修订号变更） | 对方留存的上次值 vs 现值 |

## B. 第三方侧应完成的动作（对方取证）

| # | 动作 | 通过条件 |
|---|---|---|
| B1 | 拉取轻量清单 → 发现 digest 变化 | 对方日志显示 digest 与上次不同并进入全量流程 |
| B2 | 全量重拉（`detail=1` + 分页拉明细） | 拉取条数 = `manifest.total`（含分页完整性校验、无重复） |
| B3 | **替换式写入**（整条覆盖，不做字段级 merge） | 逐字段比对：本地记录 == 接口响应（键集合一致） |
| B4 | **撤回字段不残留** | 若 `include_inspector=false`：本地 `inspector` / 复检人姓名键**必须消失** |
| B5 | 条数与结论分布对账 | 用 §C 的恒等式逐项对齐 |
| B6 | 新增/更新/删除感知 | 新增：出现新 `record_code`；更新：`updated_at` 变化项内容同步；删除：清单缺失项按约定处理（**标记撤回，不物理删**） |
| B7 | 异常路径 | 409（授权/策略变化）→ 重新对账；429 → 按 `Retry-After` 退避；网络/5xx → 重试**且不得把失败当空清单** |
| B8 | **失败不误报完成** | 失败轮次后 `digest`/水位**不得推进**；下一轮仍会重试并在成功后补齐 |
| B9 | 断点与完成状态分离 | 分页游标只代表"本页进度"，不代表"整轮完成"；整轮完成以"tail 校验一致 + 一次性提交"为准 |

## C. 对账恒等式（必须成立）

```
授权带业务日期范围时：
  manifest.total == stats.scope_total                       （范围内、日期合法）
  stats.universe_total == scope_total + request_out_of_range_total + excluded_total
无授权日期范围时：
  manifest.total == stats.scope_total + stats.excluded_total
  （/test-records 会含日期缺失/非法记录；stats 分母不含它们）
请求范围与授权范围不一致时：
  差异由 stats.request_out_of_range_total 解释
结论分布：
  pass_count(初检口径) 与明细 final_conclusion=pass 的条数**可能不同**（复检记录）——
  这是预期差异，见 stats.metric_basis 与 metric_basis_note
```

## D. 通过条件与证据格式

1. **通过** = B1–B9 均有对方侧日志/数据快照 + §C 恒等式在该校当前数据上全部成立。
2. 证据格式建议：`日期 + 学校 + 请求 URL（脱敏，不含密钥）+ 响应关键字段截图/JSON + 本地库计数`。
3. **失败处理**：若某一项不成立 → 先确认是否属"日期缺失/非法记录""复检口径差异""授权范围外记录"三类**已知解释**；
   若都不属于 → 按平台 5xx/契约类问题上报（附 `manifest.digest`、`projection_fingerprint`、`scope_version`、请求时间）。
