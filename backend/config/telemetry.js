/**
 * P1-12: telemetry.js 已改为 ESM（与项目 type:module 统一）
 * 注意：@opentelemetry/* 依赖尚未安装，此文件当前不可执行。
 * 集成到主进程（server.js）待 TD-P2-16 完成后实施。
 * 正确集成方式：node --import ./config/telemetry.js server.js
 *
 * OpenTelemetry 配置
 * 用于应用的可观测性和性能监控
 */

// P1-12: 改为 ESM，与项目 type:module 统一（依赖未安装，集成 deferred，见 TD-P2-16）
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { JaegerExporter } from '@opentelemetry/exporter-trace-jaeger';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

// 配置资源信息
const resource = Resource.default().merge(
  new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'foodtestlab-app',
    [SemanticResourceAttributes.SERVICE_VERSION]: '3.1.0',
    environment: process.env.NODE_ENV || 'development',
  }),
);

// 初始化 Jaeger 导出器
const jaegerExporter = new JaegerExporter({
  endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
  serviceName: 'foodtestlab-app',
});

// 初始化 Prometheus 导出器
const prometheusExporter = new PrometheusExporter(
  {
    port: parseInt(process.env.METRICS_PORT || '9464'),
    endpoint: '/metrics',
  },
  () => {
    console.log('✅ Prometheus metrics server started on port 9464');
  },
);

// 初始化 OpenTelemetry SDK
const sdk = new NodeSDK({
  resource: resource,
  traceExporter: jaegerExporter,
  metricExporter: prometheusExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-express': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-pg': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-http': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-fs': {
        enabled: true,
      },
    }),
  ],
});

// 启动 SDK
sdk.start();

console.log('🎯 OpenTelemetry SDK started');
console.log(`📡 Tracing exporter: Jaeger (${process.env.JAEGER_ENDPOINT || 'http://localhost:14268'})`);
console.log(`📊 Metrics exporter: Prometheus (port 9464)`);

// 优雅关闭处理
process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => {
      console.log('🛑 OpenTelemetry SDK shut down successfully');
      process.exit(0);
    })
    .catch((log) => {
      console.error('❌ Error shutting down OpenTelemetry SDK:', log);
      process.exit(1);
    });
});

export default sdk;
