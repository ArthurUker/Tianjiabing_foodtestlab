/**
 * 同步路由 - 处理离线模式下的数据同步
 * 
 * 端点:
 * POST /api/sync/users - 同步用户数据
 * POST /api/sync/testRecords - 同步测试记录
 * POST /api/sync/status - 获取同步状态
 * DELETE /api/sync/queue/:id - 清理同步记录
 */

const express = require('express');
const router = express.Router();

// 用于存储未完成的同步操作
const syncQueue = new Map();
const syncLog = [];

/**
 * 同步用户数据
 */
router.post('/sync/users', async (req, res) => {
  try {
    const { action, data, syncId, timestamp } = req.body;

    console.log(`[SYNC] 用户数据同步 - Action: ${action}, SyncId: ${syncId}`);

    if (!action || !data) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数'
      });
    }

    // 记录同步日志
    const logEntry = {
      syncId,
      action,
      store: 'users',
      timestamp: new Date(timestamp),
      receivedAt: new Date(),
      status: 'processing'
    };

    syncLog.push(logEntry);

    try {
      let result;

      switch (action) {
        case 'add':
          // 创建新用户
          result = {
            ...data,
            id: data.id || `user_${Date.now()}`,
            createdAt: new Date(),
            synced: true
          };
          console.log(`✓ 用户已添加: ${result.id}`);
          break;

        case 'update':
          // 更新用户信息
          result = {
            ...data,
            updatedAt: new Date(),
            synced: true
          };
          console.log(`✓ 用户已更新: ${result.id}`);
          break;

        case 'delete':
          // 删除用户
          result = {
            id: data.id,
            deleted: true,
            synced: true
          };
          console.log(`✓ 用户已删除: ${data.id}`);
          break;

        default:
          throw new Error(`未知操作: ${action}`);
      }

      // 更新日志
      logEntry.status = 'completed';
      logEntry.result = result;

      res.json({
        success: true,
        syncId,
        action,
        data: result,
        syncedAt: new Date()
      });

    } catch (error) {
      logEntry.status = 'failed';
      logEntry.error = error.message;
      
      res.status(500).json({
        success: false,
        syncId,
        error: error.message
      });
    }
  } catch (error) {
    console.error('[SYNC ERROR]', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 同步测试记录
 */
router.post('/sync/testRecords', async (req, res) => {
  try {
    const { action, data, syncId, timestamp } = req.body;

    console.log(`[SYNC] 测试记录同步 - Action: ${action}, SyncId: ${syncId}`);

    if (!action || !data) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数'
      });
    }

    const logEntry = {
      syncId,
      action,
      store: 'testRecords',
      timestamp: new Date(timestamp),
      receivedAt: new Date(),
      status: 'processing'
    };

    syncLog.push(logEntry);

    try {
      let result;

      switch (action) {
        case 'add':
          result = {
            ...data,
            id: data.id || `record_${Date.now()}`,
            createdAt: new Date(),
            synced: true
          };
          console.log(`✓ 测试记录已添加: ${result.id}`);
          break;

        case 'update':
          result = {
            ...data,
            updatedAt: new Date(),
            synced: true
          };
          console.log(`✓ 测试记录已更新: ${result.id}`);
          break;

        case 'delete':
          result = {
            id: data.id,
            deleted: true,
            synced: true
          };
          console.log(`✓ 测试记录已删除: ${data.id}`);
          break;

        default:
          throw new Error(`未知操作: ${action}`);
      }

      logEntry.status = 'completed';
      logEntry.result = result;

      res.json({
        success: true,
        syncId,
        action,
        data: result,
        syncedAt: new Date()
      });

    } catch (error) {
      logEntry.status = 'failed';
      logEntry.error = error.message;
      
      res.status(500).json({
        success: false,
        syncId,
        error: error.message
      });
    }
  } catch (error) {
    console.error('[SYNC ERROR]', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 批量同步数据
 */
router.post('/sync/batch', async (req, res) => {
  try {
    const { operations } = req.body;

    if (!Array.isArray(operations)) {
      return res.status(400).json({
        success: false,
        error: '操作必须是数组'
      });
    }

    console.log(`[SYNC] 批量同步 - ${operations.length} 条操作`);

    const results = [];
    const errors = [];

    for (const op of operations) {
      try {
        const result = await processSyncOperation(op);
        results.push(result);
      } catch (error) {
        errors.push({
          syncId: op.syncId,
          error: error.message
        });
      }
    }

    res.json({
      success: errors.length === 0,
      total: operations.length,
      succeeded: results.length,
      failed: errors.length,
      results,
      errors
    });

  } catch (error) {
    console.error('[SYNC ERROR]', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 处理单个同步操作
 */
async function processSyncOperation(op) {
  const { action, store, data, syncId } = op;

  // 这里应该调用实际的数据库操作
  // 这里简化处理
  return {
    syncId,
    action,
    store,
    success: true,
    data: {
      ...data,
      synced: true,
      syncedAt: new Date()
    }
  };
}

/**
 * 获取同步状态
 */
router.get('/sync/status', (req, res) => {
  const totalOps = syncLog.length;
  const completed = syncLog.filter(l => l.status === 'completed').length;
  const failed = syncLog.filter(l => l.status === 'failed').length;
  const processing = syncLog.filter(l => l.status === 'processing').length;

  const byStore = {};
  syncLog.forEach(log => {
    if (!byStore[log.store]) {
      byStore[log.store] = { total: 0, completed: 0, failed: 0 };
    }
    byStore[log.store].total++;
    if (log.status === 'completed') byStore[log.store].completed++;
    if (log.status === 'failed') byStore[log.store].failed++;
  });

  res.json({
    status: 'ok',
    timestamp: new Date(),
    summary: {
      totalOperations: totalOps,
      completed,
      failed,
      processing,
      successRate: totalOps > 0 ? `${(completed / totalOps * 100).toFixed(2)}%` : '0%'
    },
    byStore,
    recentLogs: syncLog.slice(-10)
  });
});

/**
 * 获取同步队列
 */
router.get('/sync/queue', (req, res) => {
  const pending = syncLog.filter(l => l.status !== 'completed');

  res.json({
    count: pending.length,
    items: pending.map(p => ({
      syncId: p.syncId,
      store: p.store,
      action: p.action,
      status: p.status,
      timestamp: p.timestamp,
      receivedAt: p.receivedAt,
      error: p.error
    }))
  });
});

/**
 * 清空同步日志
 */
router.delete('/sync/queue', (req, res) => {
  const count = syncLog.length;
  syncLog.length = 0;
  syncQueue.clear();

  res.json({
    success: true,
    message: `已清空 ${count} 条同步记录`
  });
});

/**
 * 获取同步统计
 */
router.get('/sync/stats', (req, res) => {
  const stats = {
    timestamp: new Date(),
    totalSyncs: syncLog.length,
    byAction: {},
    byStore: {},
    byStatus: {},
    averageTime: 0
  };

  // 统计数据
  syncLog.forEach(log => {
    // 按操作统计
    if (!stats.byAction[log.action]) {
      stats.byAction[log.action] = 0;
    }
    stats.byAction[log.action]++;

    // 按存储统计
    if (!stats.byStore[log.store]) {
      stats.byStore[log.store] = 0;
    }
    stats.byStore[log.store]++;

    // 按状态统计
    if (!stats.byStatus[log.status]) {
      stats.byStatus[log.status] = 0;
    }
    stats.byStatus[log.status]++;
  });

  // 计算平均时间
  const times = syncLog
    .filter(l => l.receivedAt && l.timestamp)
    .map(l => l.receivedAt - l.timestamp);

  if (times.length > 0) {
    stats.averageTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  }

  res.json(stats);
});

module.exports = router;
