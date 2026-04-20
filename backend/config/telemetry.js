/**
 * OpenTelemetry 配置
 * 用于应用的可观测性和性能监控
 */

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { JaegerExporter } = require('@opentelemetry/exporter-trace-jaeger');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

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

module.exports = sdk;
