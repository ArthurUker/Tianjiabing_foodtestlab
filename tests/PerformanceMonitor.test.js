/**
 * PerformanceMonitor 单元测试
 * 测试性能监控、指标收集、性能分析等功能
 */

describe('PerformanceMonitor - 性能监控', () => {
  // 模拟性能监控器
  class PerformanceMonitor {
    constructor() {
      this.metrics = new Map();
      this.timers = new Map();
      this.marks = [];
    }

    // 开始计时
    startTimer(label) {
      this.timers.set(label, Date.now());
    }

    // 结束计时并记录
    endTimer(label) {
      const startTime = this.timers.get(label);
      if (!startTime) {
        throw new Error(`Timer "${label}" not found`);
      }

      const duration = Date.now() - startTime;
      this.timers.delete(label);

      // 记录指标
      if (!this.metrics.has(label)) {
        this.metrics.set(label, {
          label,
          count: 0,
          totalTime: 0,
          minTime: Infinity,
          maxTime: -Infinity,
          measurements: []
        });
      }

      const metric = this.metrics.get(label);
      metric.count++;
      metric.totalTime += duration;
      metric.minTime = Math.min(metric.minTime, duration);
      metric.maxTime = Math.max(metric.maxTime, duration);
      metric.measurements.push(duration);

      return duration;
    }

    // 记录标记
    mark(name) {
      this.marks.push({
        name,
        timestamp: Date.now()
      });
    }

    // 获取指标统计
    getMetric(label) {
      const metric = this.metrics.get(label);
      if (!metric) return null;

      return {
        label: metric.label,
        count: metric.count,
        avgTime: metric.totalTime / metric.count,
        minTime: metric.minTime,
        maxTime: metric.maxTime,
        totalTime: metric.totalTime
      };
    }

    // 获取所有指标
    getAllMetrics() {
      const results = [];
      for (const [, metric] of this.metrics) {
        results.push({
          label: metric.label,
          count: metric.count,
          avgTime: metric.totalTime / metric.count,
          minTime: metric.minTime,
          maxTime: metric.maxTime,
          totalTime: metric.totalTime
        });
      }
      return results;
    }

    // 获取性能报告
    generateReport() {
      const metrics = this.getAllMetrics();
      const totalTime = metrics.reduce((sum, m) => sum + m.totalTime, 0);

      return {
        timestamp: Date.now(),
        metrics,
        totalTime,
        operationCount: metrics.reduce((sum, m) => sum + m.count, 0)
      };
    }

    // 性能统计 (百分位数)
    getPercentile(label, percentile) {
      const metric = this.metrics.get(label);
      if (!metric) return null;

      const sorted = [...metric.measurements].sort((a, b) => a - b);
      const index = Math.ceil((percentile / 100) * sorted.length) - 1;

      return sorted[Math.max(0, index)];
    }

    // 是否性能良好
    isPerformanceGood(label, threshold = 1000) {
      const metric = this.getMetric(label);
      if (!metric) return false;

      return metric.avgTime < threshold;
    }

    // 获取慢操作
    getSlowOperations(threshold = 1000) {
      const slow = [];
      for (const [label, metric] of this.metrics) {
        const avgTime = metric.totalTime / metric.count;
        if (avgTime > threshold) {
          slow.push({
            label,
            avgTime,
            count: metric.count
          });
        }
      }
      return slow;
    }

    // 重置指标
    resetMetrics() {
      this.metrics.clear();
      this.timers.clear();
      this.marks = [];
    }

    // 获取内存使用情况
    getMemoryUsage() {
      if (performance.memory) {
        return {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
        };
      }
      return null;
    }

    // 比较性能
    compareMetrics(label1, label2) {
      const m1 = this.getMetric(label1);
      const m2 = this.getMetric(label2);

      if (!m1 || !m2) return null;

      const diff = m1.avgTime - m2.avgTime;
      const percentDiff = (diff / m2.avgTime) * 100;

      return {
        label1,
        label2,
        avgTime1: m1.avgTime,
        avgTime2: m2.avgTime,
        difference: diff,
        percentDifference: percentDiff,
        faster: percentDiff < 0 ? label2 : label1
      };
    }

    // 导出数据为JSON
    exportToJSON() {
      return {
        timestamp: Date.now(),
        metrics: this.getAllMetrics(),
        marks: this.marks
      };
    }
  }

  let monitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  describe('计时功能', () => {
    test('应该启动和停止计时', () => {
      monitor.startTimer('test');
      const duration = monitor.endTimer('test');

      expect(duration).toBeGreaterThanOrEqual(0);
    });

    test('应该抛出错误当计时器不存在时', () => {
      expect(() => {
        monitor.endTimer('nonexistent');
      }).toThrow('Timer "nonexistent" not found');
    });

    test('应该记录多个计时', () => {
      monitor.startTimer('op1');
      monitor.startTimer('op2');

      monitor.endTimer('op1');
      monitor.endTimer('op2');

      expect(monitor.getMetric('op1')).toBeTruthy();
      expect(monitor.getMetric('op2')).toBeTruthy();
    });
  });

  describe('指标统计', () => {
    test('应该计算平均时间', () => {
      monitor.startTimer('test');
      monitor.endTimer('test');
      monitor.startTimer('test');
      monitor.endTimer('test');

      const metric = monitor.getMetric('test');

      expect(metric.count).toBe(2);
      expect(metric.avgTime).toBeGreaterThanOrEqual(0);
    });

    test('应该跟踪最小和最大时间', () => {
      monitor.startTimer('test');
      monitor.endTimer('test');

      monitor.startTimer('test');
      monitor.endTimer('test');

      const metric = monitor.getMetric('test');

      expect(metric.minTime).toBeLessThanOrEqual(metric.maxTime);
    });

    test('应该返回null当指标不存在时', () => {
      const metric = monitor.getMetric('nonexistent');
      expect(metric).toBeNull();
    });

    test('应该获取所有指标', () => {
      monitor.startTimer('op1');
      monitor.endTimer('op1');
      monitor.startTimer('op2');
      monitor.endTimer('op2');

      const metrics = monitor.getAllMetrics();

      expect(metrics.length).toBe(2);
    });
  });

  describe('标记功能', () => {
    test('应该记录标记', () => {
      monitor.mark('start');
      monitor.mark('end');

      expect(monitor.marks.length).toBe(2);
    });

    test('应该记录标记时间戳', () => {
      const before = Date.now();
      monitor.mark('test');
      const after = Date.now();

      expect(monitor.marks[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(monitor.marks[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('性能报告', () => {
    test('应该生成性能报告', () => {
      monitor.startTimer('op1');
      monitor.endTimer('op1');

      const report = monitor.generateReport();

      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('metrics');
      expect(report).toHaveProperty('totalTime');
      expect(report).toHaveProperty('operationCount');
    });

    test('应该正确计算总时间', () => {
      monitor.startTimer('op1');
      monitor.endTimer('op1');
      monitor.startTimer('op2');
      monitor.endTimer('op2');

      const report = monitor.generateReport();

      expect(report.totalTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('百分位数分析', () => {
    test('应该计算百分位数', () => {
      // 添加多个测量值
      for (let i = 1; i <= 100; i++) {
        monitor.metrics.set('test', {
          label: 'test',
          count: i,
          totalTime: i * 100,
          minTime: 10,
          maxTime: 1000,
          measurements: Array.from({ length: i }, (_, idx) => (idx + 1) * 10)
        });
      }

      const p50 = monitor.getPercentile('test', 50);
      const p99 = monitor.getPercentile('test', 99);

      expect(p50).toBeLessThanOrEqual(p99);
    });
  });

  describe('性能判断', () => {
    test('应该判断性能是否良好', () => {
      monitor.startTimer('fast');
      // 模拟快速操作
      for (let i = 0; i < 10; i++);
      monitor.endTimer('fast');

      const isGood = monitor.isPerformanceGood('fast', 1000);
      expect(isGood).toBe(true);
    });

    test('应该识别慢操作', () => {
      monitor.metrics.set('slow', {
        label: 'slow',
        count: 1,
        totalTime: 2000,
        minTime: 2000,
        maxTime: 2000,
        measurements: [2000]
      });

      const slow = monitor.getSlowOperations(1000);

      expect(slow.length).toBeGreaterThan(0);
      expect(slow[0].label).toBe('slow');
    });
  });

  describe('性能对比', () => {
    test('应该对比两个操作的性能', () => {
      monitor.metrics.set('op1', {
        label: 'op1',
        count: 1,
        totalTime: 100,
        minTime: 100,
        maxTime: 100,
        measurements: [100]
      });

      monitor.metrics.set('op2', {
        label: 'op2',
        count: 1,
        totalTime: 200,
        minTime: 200,
        maxTime: 200,
        measurements: [200]
      });

      const comparison = monitor.compareMetrics('op1', 'op2');

      expect(comparison.avgTime1).toBe(100);
      expect(comparison.avgTime2).toBe(200);
      expect(comparison.faster).toBe('op1');
    });

    test('应该返回null当操作不存在时', () => {
      const comparison = monitor.compareMetrics('op1', 'nonexistent');
      expect(comparison).toBeNull();
    });
  });

  describe('数据导出', () => {
    test('应该导出为JSON', () => {
      monitor.startTimer('op1');
      monitor.endTimer('op1');
      monitor.mark('test');

      const json = monitor.exportToJSON();

      expect(json).toHaveProperty('timestamp');
      expect(json).toHaveProperty('metrics');
      expect(json).toHaveProperty('marks');
    });
  });

  describe('重置功能', () => {
    test('应该重置所有指标', () => {
      monitor.startTimer('op1');
      monitor.endTimer('op1');
      monitor.mark('test');

      monitor.resetMetrics();

      expect(monitor.metrics.size).toBe(0);
      expect(monitor.marks.length).toBe(0);
    });
  });

  describe('实际性能场景', () => {
    test('应该测量数组操作性能', () => {
      monitor.startTimer('array-operations');

      const arr = [];
      for (let i = 0; i < 10000; i++) {
        arr.push(i);
      }

      monitor.endTimer('array-operations');

      const metric = monitor.getMetric('array-operations');
      expect(metric.avgTime).toBeGreaterThanOrEqual(0);
    });

    test('应该测量对象操作性能', () => {
      monitor.startTimer('object-operations');

      const obj = {};
      for (let i = 0; i < 10000; i++) {
        obj[`key_${i}`] = i;
      }

      monitor.endTimer('object-operations');

      const metric = monitor.getMetric('object-operations');
      expect(metric.avgTime).toBeGreaterThanOrEqual(0);
    });

    test('应该测量JSON操作性能', () => {
      monitor.startTimer('json-operations');

      const data = { test: 'data', nested: { value: 123 } };
      JSON.stringify(data);
      JSON.parse(JSON.stringify(data));

      monitor.endTimer('json-operations');

      const metric = monitor.getMetric('json-operations');
      expect(metric).toBeTruthy();
    });

    test('应该跟踪多个操作的性能', () => {
      const operations = ['read', 'write', 'delete', 'query', 'update'];

      operations.forEach(op => {
        monitor.startTimer(op);
        // 模拟操作
        for (let i = 0; i < 1000; i++);
        monitor.endTimer(op);
      });

      const report = monitor.generateReport();
      expect(report.operationCount).toBe(operations.length);
    });
  });

  describe('内存监控', () => {
    test('应该获取内存使用信息 (如果可用)', () => {
      const memory = monitor.getMemoryUsage();

      // 内存信息可能不在所有环境中可用
      if (memory) {
        expect(memory).toHaveProperty('usedJSHeapSize');
        expect(memory).toHaveProperty('totalJSHeapSize');
      }
    });
  });

  describe('边界情况', () => {
    test('应该处理零时间操作', () => {
      monitor.startTimer('instant');
      monitor.endTimer('instant');

      const metric = monitor.getMetric('instant');
      expect(metric.avgTime).toBeGreaterThanOrEqual(0);
    });

    test('应该处理多次相同操作', () => {
      for (let i = 0; i < 100; i++) {
        monitor.startTimer('repeated');
        monitor.endTimer('repeated');
      }

      const metric = monitor.getMetric('repeated');
      expect(metric.count).toBe(100);
    });
  });
});
