/**
 * 性能监控器 - 测试和优化系统性能
 * 
 * 功能:
 * - 页面加载时间监控
 * - 操作执行时间测量
 * - 数据库查询性能分析
 * - API响应时间统计
 * - 性能报告生成
 */

class PerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.marks = new Map();
    this.measures = new Map();
    this.startTime = Date.now();
    this.enableLogging = true;

    // 自动记录页面加载时间
    this.recordPageLoadMetrics();
  }

  /**
   * 记录页面加载指标
   */
  recordPageLoadMetrics() {
    if (window.performance && window.performance.timing) {
      window.addEventListener('load', () => {
        setTimeout(() => {
          const timing = window.performance.timing;

          const metrics = {
            'DNS查询': timing.domainLookupEnd - timing.domainLookupStart,
            '建立连接': timing.connectEnd - timing.connectStart,
            '等待响应': timing.responseStart - timing.requestStart,
            '下载资源': timing.responseEnd - timing.responseStart,
            'DOM解析': timing.domInteractive - timing.domLoading,
            'DOM加载': timing.loadEventEnd - timing.loadEventStart,
            '总耗时': timing.loadEventEnd - timing.navigationStart
          };

          // 记录指标
          for (const [name, value] of Object.entries(metrics)) {
            if (value > 0) {
              this.record(name, value, 'ms');
            }
          }

          console.log('📊 页面加载性能指标:', metrics);
        }, 0);
      });
    }
  }

  /**
   * 记录指标
   * @param {string} name - 指标名称
   * @param {number} value - 值
   * @param {string} unit - 单位
   */
  record(name, value, unit = 'ms') {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }

    const values = this.metrics.get(name);
    values.push({ value, unit, timestamp: Date.now() });

    // 只保留最近100条记录
    if (values.length > 100) {
      values.shift();
    }

    if (this.enableLogging && values.length === 1) {
      console.log(`📈 [${name}] ${value} ${unit}`);
    }
  }

  /**
   * 创建测量点
   * @param {string} name - 标记名称
   */
  mark(name) {
    const timestamp = performance.now();
    this.marks.set(name, timestamp);
  }

  /**
   * 完成测量
   * @param {string} name - 测量名称
   * @param {string} startMark - 开始标记
   * @param {string} endMark - 结束标记
   */
  measure(name, startMark, endMark = null) {
    if (!this.marks.has(startMark)) {
      console.warn(`❌ 开始标记不存在: ${startMark}`);
      return null;
    }

    const startTime = this.marks.get(startMark);
    const endTime = endMark ? (this.marks.get(endMark) || performance.now()) : performance.now();
    const duration = endTime - startTime;

    this.measures.set(name, {
      duration,
      startTime,
      endTime,
      timestamp: Date.now()
    });

    this.record(name, duration);
    return duration;
  }

  /**
   * 记录操作执行时间
   * @param {string} name - 操作名称
   * @param {Function} fn - 要执行的函数
   * @param {*} thisArg - this上下文
   * @param {Array} args - 参数
   */
  async timeOperation(name, fn, thisArg = null, args = []) {
    const startTime = performance.now();

    try {
      const result = await fn.apply(thisArg, args);
      const duration = performance.now() - startTime;
      this.record(`${name}`, duration);
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      this.record(`${name}[ERROR]`, duration);
      throw error;
    }
  }

  /**
   * 装饰器：用于自动测量函数性能
   * @param {string} name - 操作名称
   */
  measureAsync(name) {
    return (target, key, descriptor) => {
      const originalMethod = descriptor.value;

      descriptor.value = async function(...args) {
        return this.constructor.monitor.timeOperation(
          `${name || key}`,
          originalMethod,
          this,
          args
        );
      };

      return descriptor;
    };
  }

  /**
   * 获取指标统计
   * @param {string} name - 指标名称
   */
  getMetricStats(name) {
    if (!this.metrics.has(name)) {
      return null;
    }

    const values = this.metrics.get(name).map(v => v.value);

    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    return {
      name,
      count: values.length,
      min,
      max,
      avg: Math.round(avg * 100) / 100,
      median,
      p95,
      p99,
      unit: this.metrics.get(name)[0]?.unit || 'ms'
    };
  }

  /**
   * 获取所有指标的统计报告
   */
  getReport() {
    const report = {
      timestamp: new Date(),
      runtime: Math.round((Date.now() - this.startTime) / 1000) + 's',
      metrics: []
    };

    for (const [name] of this.metrics) {
      const stats = this.getMetricStats(name);
      if (stats) {
        report.metrics.push(stats);
      }
    }

    // 按平均时间排序
    report.metrics.sort((a, b) => b.avg - a.avg);

    return report;
  }

  /**
   * 打印性能报告
   */
  printReport() {
    const report = this.getReport();

    console.log('\n' + '='.repeat(60));
    console.log('📊 性能报告');
    console.log('='.repeat(60));
    console.log(`时间: ${report.timestamp}`);
    console.log(`运行时间: ${report.runtime}\n`);

    if (report.metrics.length === 0) {
      console.log('无性能数据');
      return;
    }

    // 表格头
    console.log(
      '%-30s | %10s | %8s | %8s | %8s | %8s'.replace(/%/g, '%')
        .split('|')
        .join('| %-30s |')
    );
    console.log('-'.repeat(100));

    // 表格行
    for (const metric of report.metrics) {
      const name = metric.name.substring(0, 28);
      const unit = metric.unit;
      
      console.log(
        `${name.padEnd(28)} | ${metric.avg.toString().padStart(6)} | ` +
        `${metric.min.toString().padStart(6)} | ${metric.max.toString().padStart(6)} | ` +
        `${metric.p95.toString().padStart(6)} | ${metric.p99.toString().padStart(6)} ${unit}`
      );
    }

    console.log('='.repeat(100) + '\n');
  }

  /**
   * 获取JSON格式的报告
   */
  getReportJSON() {
    return JSON.stringify(this.getReport(), null, 2);
  }

  /**
   * 导出CSV格式的报告
   */
  getReportCSV() {
    const report = this.getReport();
    const lines = [];

    // 表头
    lines.push('指标名称,计数,最小值,最大值,平均值,中位数,P95,P99,单位');

    // 数据行
    for (const metric of report.metrics) {
      lines.push(
        `"${metric.name}",${metric.count},${metric.min},${metric.max},` +
        `${metric.avg},${metric.median},${metric.p95},${metric.p99},${metric.unit}`
      );
    }

    return lines.join('\n');
  }

  /**
   * 比较两个时间点的性能差异
   */
  compareMetrics(before, after) {
    const beforeStats = this.getMetricStats(before);
    const afterStats = this.getMetricStats(after);

    if (!beforeStats || !afterStats) {
      console.warn('❌ 比较的指标不存在');
      return null;
    }

    const improvement = ((beforeStats.avg - afterStats.avg) / beforeStats.avg * 100).toFixed(2);

    return {
      before: beforeStats,
      after: afterStats,
      improvementPercent: improvement,
      isImproved: improvement > 0
    };
  }

  /**
   * 清空所有指标
   */
  clear() {
    this.metrics.clear();
    this.marks.clear();
    this.measures.clear();
    console.log('✓ 已清空所有性能指标');
  }

  /**
   * 禁用日志输出
   */
  disableLogging() {
    this.enableLogging = false;
  }

  /**
   * 启用日志输出
   */
  enableLogging() {
    this.enableLogging = true;
  }

  /**
   * 生成HTML格式的性能图表
   */
  generateChart() {
    const report = this.getReport();

    let html = `
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h2>性能监控报告</h2>
        <p>生成时间: ${report.timestamp}</p>
        <p>系统运行时间: ${report.runtime}</p>
        
        <table border="1" style="border-collapse: collapse; width: 100%; margin-top: 20px;">
          <thead>
            <tr style="background-color: #f0f0f0;">
              <th>指标</th>
              <th>计数</th>
              <th>最小值</th>
              <th>最大值</th>
              <th>平均值</th>
              <th>中位数</th>
              <th>P95</th>
              <th>P99</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const metric of report.metrics) {
      html += `
        <tr>
          <td>${metric.name}</td>
          <td>${metric.count}</td>
          <td>${metric.min} ${metric.unit}</td>
          <td>${metric.max} ${metric.unit}</td>
          <td>${metric.avg} ${metric.unit}</td>
          <td>${metric.median} ${metric.unit}</td>
          <td>${metric.p95} ${metric.unit}</td>
          <td>${metric.p99} ${metric.unit}</td>
        </tr>
      `;
    }

    html += `
        </tbody>
        </table>
      </div>
    `;

    return html;
  }
}

// 全局单例
let globalPerformanceMonitor = null;

/**
 * 获取全局性能监控器实例
 */
function getPerformanceMonitor() {
  if (!globalPerformanceMonitor) {
    globalPerformanceMonitor = new PerformanceMonitor();
  }
  return globalPerformanceMonitor;
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PerformanceMonitor, getPerformanceMonitor };
}

// 自动初始化（P2-10 阶段B：不再挂 window.perfMonitor，单例由 getPerformanceMonitor 内部持有）
if (typeof window !== 'undefined') {
  getPerformanceMonitor();
}
