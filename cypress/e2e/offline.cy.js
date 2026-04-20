/**
 * E2E 测试: 离线模式
 * 测试离线工作、网络恢复、数据同步等功能
 */

describe('E2E 测试 - 离线模式', () => {
  beforeEach(() => {
    cy.visit('/');
    
    // 登录
    cy.get('input[type="email"]').first().type('testuser@example.com');
    cy.get('input[type="password"]').first().type('TestPass123!');
    cy.contains('button', /登录|Login/).click();
    cy.url().should('not.include', 'login');
  });

  describe('网络连接检测', () => {
    it('应该显示在线状态', () => {
      // 验证在线指示器
      cy.get('[data-testid="online-status"], .status-indicator').should('contain', /在线|Online/i);
    });

    it('应该检测网络离线', () => {
      // 模拟网络离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 验证离线指示器
      cy.get('[data-testid="offline-status"], .status-indicator').should('contain', /离线|Offline/i);
    });

    it('应该在离线时显示警告', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 验证警告提示
      cy.get('[data-testid="offline-warning"], .alert-warning').should('be.visible');
    });
  });

  describe('离线数据操作', () => {
    it('应该在离线时允许创建本地记录', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 创建新记录
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type('离线记录');
      cy.contains('button', /保存|Submit/).click();
      
      // 验证成功创建
      cy.get('[data-testid="success-message"], .alert-success').should('contain', /保存/i);
    });

    it('应该在离线时允许编辑记录', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 编辑记录
      cy.get('[data-testid="edit-button"]').first().click();
      cy.get('input[name="name"]').clear().type('离线编辑');
      cy.contains('button', /保存|Update/).click();
      
      // 验证成功
      cy.get('[data-testid="success-message"]').should('be.visible');
    });

    it('应该在离线时允许删除记录', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 删除记录
      cy.get('[data-testid="delete-button"]').first().click();
      cy.get('[data-testid="confirm-button"]').click();
      
      // 验证成功
      cy.get('[data-testid="success-message"]').should('be.visible');
    });

    it('应该在离线时将操作放入待同步队列', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 创建多个记录
      for (let i = 0; i < 3; i++) {
        cy.get('[data-testid="create-button"]').click();
        cy.get('input[name="name"]').type(`离线记录 ${i}`);
        cy.contains('button', /保存|Submit/).click();
        cy.get('[data-testid="create-button"]').click();
      }
      
      // 验证待同步数量
      cy.get('[data-testid="sync-queue-count"]').should('contain', '3');
    });
  });

  describe('自动同步', () => {
    it('应该在恢复连接时自动同步', () => {
      // 模拟离线并创建记录
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type('待同步记录');
      cy.contains('button', /保存|Submit/).click();
      
      // 恢复连接
      cy.window().then(win => {
        win.dispatchEvent(new Event('online'));
      });
      
      // 验证同步进行中
      cy.get('[data-testid="syncing-status"]').should('contain', /同步中|Syncing/i);
      
      // 等待同步完成
      cy.get('[data-testid="sync-complete"]', { timeout: 5000 }).should('be.visible');
    });

    it('应该显示同步进度', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 创建多个记录
      for (let i = 0; i < 3; i++) {
        cy.get('[data-testid="create-button"]').click();
        cy.get('input[name="name"]').type(`记录 ${i}`);
        cy.contains('button', /保存|Submit/).click();
      }
      
      // 恢复连接
      cy.window().then(win => {
        win.dispatchEvent(new Event('online'));
      });
      
      // 验证进度显示
      cy.get('[data-testid="sync-progress"]').should('be.visible');
    });

    it('应该处理同步中的错误', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 创建记录
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type('错误测试');
      cy.contains('button', /保存|Submit/).click();
      
      // 模拟同步失败
      cy.intercept('POST', '/api/**', {
        statusCode: 500,
        body: { error: '服务器错误' }
      });
      
      // 恢复连接
      cy.window().then(win => {
        win.dispatchEvent(new Event('online'));
      });
      
      // 验证错误提示
      cy.get('[data-testid="sync-error"]', { timeout: 5000 }).should('be.visible');
    });

    it('应该支持手动同步', () => {
      // 离线创建记录
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type('手动同步');
      cy.contains('button', /保存|Submit/).click();
      
      // 不自动恢复，手动同步
      cy.get('[data-testid="manual-sync"], button:contains("同步")').click();
      
      // 验证同步完成
      cy.get('[data-testid="sync-complete"]', { timeout: 5000 }).should('be.visible');
    });
  });

  describe('冲突解决', () => {
    it('应该检测服务器端修改冲突', () => {
      // 在离线时修改记录
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      cy.get('[data-testid="edit-button"]').first().click();
      cy.get('input[name="name"]').clear().type('本地修改');
      cy.contains('button', /保存|Update/).click();
      
      // 模拟服务器端的冲突
      cy.intercept('PUT', '/api/**', {
        statusCode: 409,
        body: { error: '版本冲突', serverVersion: '远程版本' }
      });
      
      // 恢复连接
      cy.window().then(win => {
        win.dispatchEvent(new Event('online'));
      });
      
      // 验证冲突提示
      cy.get('[data-testid="conflict-dialog"]', { timeout: 5000 }).should('be.visible');
    });

    it('应该允许用户选择冲突解决策略', () => {
      // 制造冲突场景（代码略，假设冲突对话框显示）
      cy.get('[data-testid="conflict-dialog"]').should('be.visible');
      
      // 选择保留本地版本
      cy.get('[data-testid="keep-local"]').click();
      
      // 验证本地版本被保留
      cy.get('[data-testid="success-message"]').should('contain', /保留本地/i);
    });

    it('应该支持服务器优先策略', () => {
      // 假设冲突对话框显示
      cy.get('[data-testid="conflict-dialog"]').should('be.visible');
      
      // 选择保留服务器版本
      cy.get('[data-testid="keep-remote"]').click();
      
      // 验证服务器版本被应用
      cy.get('[data-testid="success-message"]').should('contain', /已更新为服务器版本/i);
    });
  });

  describe('离线缓存', () => {
    it('应该将数据缓存到本地存储', () => {
      // 获取数据
      cy.get('[data-testid="records-list"]').should('be.visible');
      
      // 验证缓存存在
      cy.window().then(win => {
        const cached = win.localStorage.getItem('records_cache');
        expect(cached).to.not.be.null;
      });
    });

    it('应该在离线时使用缓存数据', () => {
      // 第一次加载
      cy.get('[data-testid="records-list"]').should('be.visible');
      cy.get('tbody tr').then(rows => {
        const initialCount = rows.length;
        
        // 模拟离线
        cy.window().then(win => {
          win.dispatchEvent(new Event('offline'));
        });
        
        // 刷新页面
        cy.reload();
        
        // 验证缓存数据仍然显示
        cy.get('tbody tr').should('have.length', initialCount);
      });
    });

    it('应该更新缓存失效时间', () => {
      cy.window().then(win => {
        const cacheTime = win.localStorage.getItem('cache_time');
        expect(cacheTime).to.not.be.null;
        
        const cacheDate = new Date(parseInt(cacheTime));
        const now = new Date();
        const diffMinutes = (now - cacheDate) / 1000 / 60;
        
        // 缓存应该是最近的
        expect(diffMinutes).to.be.lessThan(5);
      });
    });
  });

  describe('离线指示器', () => {
    it('应该显示离线状态图标', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 验证图标显示
      cy.get('[data-testid="offline-icon"]').should('be.visible');
    });

    it('应该显示待同步项目数', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 创建几个记录
      for (let i = 0; i < 2; i++) {
        cy.get('[data-testid="create-button"]').click();
        cy.get('input[name="name"]').type(`记录 ${i}`);
        cy.contains('button', /保存|Submit/).click();
      }
      
      // 验证计数器显示
      cy.get('[data-testid="pending-count"]').should('contain', '2');
    });
  });

  describe('用户通知', () => {
    it('应该在离线时通知用户', () => {
      // 模拟离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 验证通知
      cy.get('[data-testid="offline-notification"], .notification').should('contain', /离线|Offline/i);
    });

    it('应该在重新连接时通知用户', () => {
      // 先离线
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      // 然后连接
      cy.window().then(win => {
        win.dispatchEvent(new Event('online'));
      });
      
      // 验证重新连接通知
      cy.get('[data-testid="online-notification"], .notification').should('contain', /已连接|Connected/i);
    });

    it('应该在同步完成时通知用户', () => {
      // 离线创建
      cy.window().then(win => {
        win.dispatchEvent(new Event('offline'));
      });
      
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type('同步通知');
      cy.contains('button', /保存|Submit/).click();
      
      // 恢复连接并同步
      cy.window().then(win => {
        win.dispatchEvent(new Event('online'));
      });
      
      // 验证完成通知
      cy.get('[data-testid="sync-complete-notification"]', { timeout: 5000 }).should('contain', /同步完成/i);
    });
  });
});
