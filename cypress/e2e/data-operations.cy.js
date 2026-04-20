/**
 * E2E 测试: 数据操作流程（CRUD）
 * 测试创建、读取、更新、删除等数据操作
 */

describe('E2E 测试 - 数据操作流程', () => {
  beforeEach(() => {
    // 访问首页并登录
    cy.visit('/');
    
    // 执行登录
    cy.get('input[type="email"]').first().type('testuser@example.com');
    cy.get('input[type="password"]').first().type('TestPass123!');
    cy.contains('button', /登录|Login/).click();
    
    // 等待页面加载
    cy.url().should('not.include', 'login');
    cy.get('[data-testid="dashboard"], .main-content').should('be.visible');
  });

  describe('创建数据', () => {
    it('应该打开创建表单', () => {
      // 点击创建按钮
      cy.get('[data-testid="create-button"], button:contains("创建")').click();
      
      // 验证表单显示
      cy.get('[data-testid="create-form"], form').should('be.visible');
    });

    it('应该成功创建新记录', () => {
      // 打开创建表单
      cy.get('[data-testid="create-button"], button:contains("创建")').click();
      
      // 填充表单
      cy.get('input[name="name"], input[placeholder*="名称"]').type('测试项目');
      cy.get('input[name="type"], select[name="type"]').select('test');
      cy.get('textarea[name="description"], textarea[placeholder*="描述"]').type('这是一个测试项目');
      
      // 提交表单
      cy.contains('button', /保存|Submit/).click();
      
      // 验证成功
      cy.get('[data-testid="success-message"], .alert-success').should('contain', /创建成功/i);
      
      // 验证记录显示在列表中
      cy.get('[data-testid="records-list"], table tbody').should('contain', '测试项目');
    });

    it('应该验证必填字段', () => {
      // 打开创建表单
      cy.get('[data-testid="create-button"], button:contains("创建")').click();
      
      // 提交空表单
      cy.contains('button', /保存|Submit/).click();
      
      // 验证验证错误
      cy.get('[data-testid="error-message"], .error, .alert-danger').should('be.visible');
    });

    it('应该防止重复提交', () => {
      // 打开创建表单
      cy.get('[data-testid="create-button"], button:contains("创建")').click();
      
      // 填充表单
      cy.get('input[name="name"]').type('项目名称');
      
      // 快速点击两次提交按钮
      cy.contains('button', /保存|Submit/).click();
      cy.contains('button', /保存|Submit/).click();
      
      // 应该只创建一个记录
      cy.intercept('POST', '/api/**').as('createRequest');
      cy.wait('@createRequest');
      
      // 验证只有一次请求
      cy.get('@createRequest.all').should('have.length', 1);
    });

    it('应该支持批量创建', () => {
      // 如果系统支持批量创建
      cy.get('[data-testid="import-button"], button:contains("导入")').click();
      
      // 上传CSV文件
      cy.get('input[type="file"]').attachFile('records.csv');
      
      // 点击导入
      cy.contains('button', /导入|Import/).click();
      
      // 验证导入成功
      cy.get('[data-testid="success-message"]').should('contain', /导入成功/i);
    });
  });

  describe('读取数据', () => {
    it('应该显示记录列表', () => {
      // 验证列表显示
      cy.get('[data-testid="records-list"], table').should('be.visible');
      cy.get('tbody tr').should('have.length.greaterThan', 0);
    });

    it('应该支持分页', () => {
      // 验证分页控制存在
      cy.get('[data-testid="pagination"], .pagination').should('be.visible');
      
      // 点击下一页
      cy.get('[data-testid="next-page"], .pagination a:contains("下一页")').click();
      
      // 验证页面改变
      cy.get('[data-testid="current-page"]').should('contain', '2');
    });

    it('应该支持搜索', () => {
      // 输入搜索词
      cy.get('[data-testid="search-input"], input[placeholder*="搜索"]').type('项目');
      
      // 按回车或点击搜索
      cy.get('[data-testid="search-button"], button:contains("搜索")').click();
      
      // 验证结果过滤
      cy.get('tbody tr').each(row => {
        cy.wrap(row).should('contain', '项目');
      });
    });

    it('应该支持排序', () => {
      // 点击列头排序
      cy.get('th:contains("名称"), th:contains("创建时间")').click();
      
      // 验证排序指示符
      cy.get('th:contains("名称") .sort-indicator, th:contains("名称") .arrow').should('be.visible');
    });

    it('应该显示记录详情', () => {
      // 点击记录
      cy.get('tbody tr').first().click();
      
      // 验证详情面板打开
      cy.get('[data-testid="detail-panel"], .detail-view').should('be.visible');
      
      // 验证显示详细信息
      cy.get('[data-testid="record-details"]').should('contain', /项目|记录/i);
    });

    it('应该支持导出数据', () => {
      // 点击导出按钮
      cy.get('[data-testid="export-button"], button:contains("导出")').click();
      
      // 选择导出格式
      cy.get('[data-testid="export-csv"], button:contains("CSV")').click();
      
      // 验证文件下载
      cy.readFile('cypress/downloads/records.csv').should('exist');
    });
  });

  describe('更新数据', () => {
    it('应该打开编辑表单', () => {
      // 点击编辑按钮
      cy.get('[data-testid="edit-button"], button:contains("编辑")').first().click();
      
      // 验证编辑表单显示
      cy.get('[data-testid="edit-form"], form').should('be.visible');
    });

    it('应该成功更新记录', () => {
      // 打开编辑表单
      cy.get('[data-testid="edit-button"], button:contains("编辑")').first().click();
      
      // 修改字段
      cy.get('input[name="name"]').clear().type('更新的项目名称');
      cy.get('textarea[name="description"]').clear().type('更新的描述');
      
      // 提交表单
      cy.contains('button', /保存|Update/).click();
      
      // 验证成功
      cy.get('[data-testid="success-message"], .alert-success').should('contain', /更新成功/i);
      
      // 验证列表中的更改
      cy.get('tbody').should('contain', '更新的项目名称');
    });

    it('应该在更新时进行验证', () => {
      // 打开编辑表单
      cy.get('[data-testid="edit-button"], button:contains("编辑")').first().click();
      
      // 清空必填字段
      cy.get('input[name="name"]').clear();
      
      // 提交表单
      cy.contains('button', /保存|Update/).click();
      
      // 验证验证错误
      cy.get('[data-testid="error-message"], .error').should('be.visible');
    });

    it('应该显示最后修改时间', () => {
      // 打开记录详情
      cy.get('tbody tr').first().click();
      
      // 验证显示修改时间
      cy.get('[data-testid="last-modified"], .last-modified').should('be.visible');
    });

    it('应该支持批量更新', () => {
      // 选择多条记录
      cy.get('input[type="checkbox"]').first().check();
      cy.get('input[type="checkbox"]').eq(1).check();
      
      // 点击批量操作按钮
      cy.get('[data-testid="batch-update"], button:contains("批量")').click();
      
      // 选择操作
      cy.get('[data-testid="update-status"], select').select('active');
      
      // 提交
      cy.contains('button', /确认|Submit/).click();
      
      // 验证成功
      cy.get('[data-testid="success-message"]').should('contain', /批量更新成功/i);
    });
  });

  describe('删除数据', () => {
    it('应该显示删除确认', () => {
      // 点击删除按钮
      cy.get('[data-testid="delete-button"], button:contains("删除")').first().click();
      
      // 验证确认对话框
      cy.get('[data-testid="confirm-dialog"], .modal').should('be.visible');
      cy.get('[data-testid="confirm-message"]').should('contain', /确认删除/i);
    });

    it('应该成功删除记录', () => {
      // 获取删除前的记录数
      cy.get('tbody tr').then(rows => {
        const initialCount = rows.length;
        
        // 删除第一条记录
        cy.get('[data-testid="delete-button"], button:contains("删除")').first().click();
        cy.get('[data-testid="confirm-button"], button:contains("确认")').click();
        
        // 验证成功
        cy.get('[data-testid="success-message"]').should('contain', /删除成功/i);
        
        // 验证记录数减少
        cy.get('tbody tr').should('have.length', initialCount - 1);
      });
    });

    it('应该支持撤销删除', () => {
      // 删除记录
      cy.get('[data-testid="delete-button"]').first().click();
      cy.get('[data-testid="confirm-button"]').click();
      
      // 点击撤销
      cy.get('[data-testid="undo-button"], button:contains("撤销")').click();
      
      // 验证记录恢复
      cy.get('[data-testid="success-message"]').should('contain', /恢复成功/i);
    });

    it('应该支持批量删除', () => {
      // 选择多条记录
      cy.get('input[type="checkbox"]').first().check();
      cy.get('input[type="checkbox"]').eq(1).check();
      
      // 点击删除
      cy.get('[data-testid="batch-delete"], button:contains("删除")').click();
      
      // 确认删除
      cy.get('[data-testid="confirm-button"]').click();
      
      // 验证成功
      cy.get('[data-testid="success-message"]').should('contain', /批量删除成功/i);
    });
  });

  describe('数据一致性', () => {
    it('应该防止并发修改冲突', () => {
      // 模拟两个用户同时修改
      cy.get('[data-testid="edit-button"]').first().click();
      
      // 模拟服务器端的修改
      cy.window().then(win => {
        cy.intercept('PUT', '/api/**', {
          statusCode: 409,
          body: { error: '记录已被修改' }
        });
      });
      
      // 尝试保存
      cy.get('input[name="name"]').clear().type('新值');
      cy.contains('button', /保存|Update/).click();
      
      // 验证冲突提示
      cy.get('[data-testid="error-message"]').should('contain', /修改|conflict/i);
    });

    it('应该验证数据完整性', () => {
      // 创建记录
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type('完整性测试');
      cy.contains('button', /保存|Submit/).click();
      
      // 验证数据保存
      cy.window().then(win => {
        const records = win.localStorage.getItem('records');
        expect(records).to.not.be.null;
        const parsed = JSON.parse(records);
        expect(parsed[0].name).to.equal('完整性测试');
      });
    });
  });

  describe('性能测试', () => {
    it('应该在合理时间内加载列表', () => {
      // 测量页面加载时间
      cy.window().then(win => {
        const startTime = win.performance.now();
        
        cy.get('[data-testid="records-list"]').should('be.visible');
        
        cy.window().then(w => {
          const endTime = w.performance.now();
          const duration = endTime - startTime;
          
          // 应该在1秒内加载
          expect(duration).to.be.lessThan(1000);
        });
      });
    });

    it('应该在大量数据下保持响应', () => {
      // 加载更多页面
      for (let i = 0; i < 5; i++) {
        cy.get('[data-testid="next-page"]').click();
        cy.get('[data-testid="records-list"]').should('be.visible');
      }
    });
  });
});
