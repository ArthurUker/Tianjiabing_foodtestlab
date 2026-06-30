# FIX-P1-12：telemetry.js 使用 CommonJS 且未集成到主进程

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-12` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `backend/config/telemetry.js` |
| **预估工时** | 1h |
| **关联问题** | 技术债 `TD-P2-16`（OTel 完整集成） |
| **状态** | ✅ 已完成（方案 C：ESM 化） |
| **完成日期** | 2026-06-30 |
| **代码提交** | `58f5a2d` |

---

## 1. 问题描述

`backend/config/telemetry.js` 使用 CommonJS 模块语法（`require()` / `module.exports`），与项目根目录 `package.json` 中 `"type": "module"` 声明不兼容。在 ESM 项目中加载此文件会抛出 `ReferenceError: require is not defined` 或 `ERR_REQUIRE_ESM` 错误。此外，该文件虽定义了完整的 OpenTelemetry SDK 初始化逻辑，但从未被 `server.js` 或任何入口集成，telemetry 数据实际不上报。

## 2. 根因分析

1. **历史遗留 CJS 写法**：`telemetry.js` 创建于项目尚未设置 `"type": "module"` 时期，沿用 CommonJS 语法。P0-10 将根 `package.json` 补充 `"type": "module"` 后，此文件成为项目中唯一的 CJS 残留，与项目模块系统不一致。
2. **`@opentelemetry/*` 7 个依赖从未安装**：核验 `package.json`（根 + backend）的 `dependencies` / `devDependencies`，`@opentelemetry/sdk-node`、`@opentelemetry/auto-instrumentations-node`、`@opentelemetry/sdk-metrics`、`@opentelemetry/exporter-prometheus`、`@opentelemetry/sdk-trace-node`、`@opentelemetry/exporter-trace-jaeger`、`@opentelemetry/resources`、`@opentelemetry/semantic-conventions` 均未声明。文件当前不可执行。
3. **Jaeger / Prometheus 基础设施未部署**：代码引用 `JAEGER_ENDPOINT`（默认 `http://localhost:14268`）和 `METRICS_PORT`（默认 9464），但无证据表明对应服务已部署。
4. **直接集成会导致 server.js 启动崩溃**：若在 `server.js` 内 `import './config/telemetry.js'`，因依赖缺失会立即抛 `Cannot find package '@opentelemetry/sdk-node'` 致进程退出。

## 3. 修复方案

### 方案 C（采纳 — 仅 ESM 化）

仅将 `telemetry.js` 的模块语法由 CommonJS 转为 ESM，消除 CJS/ESM 不兼容，**不接入 server.js**（避免因依赖缺失导致启动崩溃）。

```diff
- const { NodeSDK } = require('@opentelemetry/sdk-node');
- const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
- const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
- const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
- const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
- const { JaegerExporter } = require('@opentelemetry/exporter-trace-jaeger');
- const { Resource } = require('@opentelemetry/resources');
- const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
+ // P1-12: 改为 ESM，与项目 type:module 统一（依赖未安装，集成 deferred，见 TD-P2-16）
+ import { NodeSDK } from '@opentelemetry/sdk-node';
+ import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
+ import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
+ import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
+ import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
+ import { JaegerExporter } from '@opentelemetry/exporter-trace-jaeger';
+ import { Resource } from '@opentelemetry/resources';
+ import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
```

```diff
- module.exports = sdk;
+ export default sdk;
```

并在文件顶部添加 P1-12 说明注释，标注依赖未安装、集成 deferred、正确集成方式。

### 方案 B（备选 — 未采纳）

直接完成 C1 + C2（ESM 化 + 接入 server.js）。**否决原因**：`@opentelemetry/*` 7 个依赖未安装，接入后 server.js 启动即崩溃。需先完成依赖安装与基础设施部署（TD-P2-16），不可在本阶段实施。

## 4. 未实施内容

- **server.js 集成（C2）**：因 `@opentelemetry/*` 依赖缺失 deferred，待 TD-P2-16 完成后实施。
- **正确集成方式（待 TD-P2-16 实施）**：`node --import ./config/telemetry.js server.js`。OpenTelemetry 要求模块在应用代码加载**之前**完成插桩注册（patch 全局模块），因此**不可**在 `server.js` 内部 `import` telemetry.js，必须通过 Node.js `--import` 标志预加载。

## 5. 验收标准

- [x] telemetry.js 无任何 `require()` 调用（8 个全部转为 `import`）
- [x] telemetry.js 无 `module.exports`（改为 `export default`）
- [x] 顶部有 P1-12 说明注释（含集成方式提示）
- [x] `git diff --stat` 确认仅 `backend/config/telemetry.js` 1 个文件变更
- [x] server.js 未被修改（集成 deferred）

## 6. 功能影响

- telemetry 数据当前**不上报**（依赖未安装，文件不可执行），ESM 化不影响现有任何功能。
- 消除了项目中唯一的 CJS 残留，模块系统与 `"type": "module"` 统一，避免未来若有人尝试加载此文件时的 CJS/ESM 报错。

## 7. 技术债

### TD-P2-16：OpenTelemetry 完整集成

| 字段 | 内容 |
|------|------|
| **描述** | 安装 `@opentelemetry/*` 7 个依赖 + 部署 Jaeger/Prometheus 基础设施 + 修改启动脚本为 `--import` 方式 |
| **前置条件** | Jaeger / Prometheus 基础设施就绪 |
| **实施步骤** | 1. `npm install` 7 个 `@opentelemetry/*` 包；2. 部署 Jaeger + Prometheus；3. 启动脚本改为 `node --import ./config/telemetry.js server.js`；4. 配置 `JAEGER_ENDPOINT` / `METRICS_PORT` 环境变量；5. 验证 trace/metrics 上报 |
| **优先级** | P2 优化 |
| **登记日期** | 2026-06-30 |

## 8. 备注

> 本次仅执行方案 C（ESM 化），未触碰 server.js。`BatchSpanProcessor` 在 import 中保留但当前未在 SDK 初始化中使用（原代码即如此），待 TD-P2-16 实施时一并核验是否需要启用。
