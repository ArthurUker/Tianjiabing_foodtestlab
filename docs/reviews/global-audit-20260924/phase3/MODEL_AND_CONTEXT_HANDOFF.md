# Phase 3 — Model and Context Handoff Convention

本约定适用于 Astra 给用户的每一个 CodeBuddy task packet，以及 CodeBuddy 结果回来后的 Astra 下一步安排。

## 任务包末尾固定附加

在完整 TASK PACKET 之后，给用户一个短的 **切换/交接卡**：

```text
CODEBUDDY HANDOFF
TASK ID: <task id>
TASK PACKET: <absolute path>
READ FIRST: <phase3/ORCHESTRATOR_STATE.md>, <task packet 的 required pre-read 精确路径>
FIXED CONTEXT: <baseline, task-start HEAD/branch, current wave, 已通过任务与残余风险>
DO: <本次目标的一句话>
DO NOT: <本任务最关键的安全边界>

MODEL RECOMMENDATION
CodeBuddy execution: <model + effort + one-line reason>
Astra review after result: <model + effort + one-line reason>
Escalate if: <什么证据/冲突出现时升级到更强模型>
```

用户将聊天切到另一个 GPT 模型时，粘贴交接卡与 CodeBuddy 的完整结果，并要求先读指定状态和任务包，再继续。任务包和状态是权威上下文；交接卡是短索引，不代替验收条件或证据附件。只携带本任务相关审计条目、架构决策、diff 和日志，不重复整仓/49 findings。

## CodeBuddy 最终回复增加

所有 task packet 的 FINAL RESPONSE FORMAT 在最末增加：

```text
ASTRA REVIEW HANDOFF
TASK ID / packet path:
task-start HEAD / branch:
accepted Phase 2 or prior-task decisions:
changed-file list and diff summary:
evidence/log paths and exact test outcomes:
known baseline failures / new failures / skips:
unresolved decisions or residual risks:
recommended Astra model + reasoning effort + reason:
escalation trigger:
```

CodeBuddy 的模型建议是给下一位 GPT 审阅者参考，Astra 自己作最终模型建议。不得只写“需要强模型”；必须给具体 model/effort 并依据任务范围说明原因。不建议在 model/effort 之间来回反复切换来替代上下文交接。

## 建议档位

- **GPT-6 Luna — Extra High**：任务范围清楚、架构已定的单个 CodeBuddy 结果审阅、日志/验收矩阵核对、任务包生成、状态恢复。
- **GPT-6 Sol — Extra High**：多模块 diff/兼容路径联动、几组测试冲突或复杂普通实现审查，需更强日常技术判断。
- **GPT-6 Astra — Extra High**：认证/授权、迁移修复策略、备份恢复/数据丢失、严重度重判、跨 wave 冲突、撤回已定安全语义或最终发布/安全裁决。
- **Astra Max**：仅在证据彼此冲突、多个安全边界同时争议、且 Extra High 仍无法定案时建议；不是常规默认。

思考强度不能替代模型本身能力、明确范围、可复现证据或正确隔离。任务简单而验收确定时，不因“听起来严重”自动升 Max；遇到上述安全裁决时，不因 Luna Extra High 有时间预算就默认足够。GPT 名称/思考档位在当前产品中若未提供，以 UI 可选项为准，并说明替代建议；不要假称已切换模型。

## 当前 Phase 3 默认

- 当前 P3-PF-T01-R1 是限定的 probe/document rework。执行仍用 CodeBuddy 原工具；完成后将证据目录和 diff 交回 Astra。Astra review 建议 **GPT-6 Luna Extra High**，因为问题面已收敛为可逐项核对的 probe 退出码、清理范围与证据措辞；如 rework 揭示新的业务判定分歧，再由 **GPT-6 Astra Extra High** 决策。
- W0 常规 guard 的有界实现和单元测试通常可用 **GPT-6 Luna Extra High**；若遇到测试隔离、启动顺序与 secret 流程冲突，升 **Sol Extra High**。
- migration/认证 session epoch/backup restore/离线冲突协议/权限架构任务以 **Astra Extra High** 做方案/最终 review；CodeBuddy 按小 packet 执行，不自行定设计。

模型产品说明：[OpenAI Model selection](https://developers.openai.com/api/docs/guides/model-selection)。该说明将 Luna Extra High 用于明确约束下的上下文收集和排序，将 Astra Extra High 用于高要求深度分析；实际可用档位依产品而异。
