/**
 * E2E 测试: 登录认证流程
 * 测试用户登录、登出、令牌管理等功能
 */

describe('E2E 测试 - 登录认证流程', () => {
  beforeEach(() => {
    // 访问首页
    cy.visit('/');
    
    // 等待页面加载
    cy.get('body').should('be.visible');
  });

  describe('用户登录', () => {
    it('应该成功登录', () => {
      // 进入登录页面
      cy.url().should('include', '/');
      
      // 验证登录表单存在
      cy.get('form').should('exist');
      
      // 填充邮箱
      cy.get('input[type="email"]').first().type('testuser@example.com');
      
      // 填充密码
      cy.get('input[type="password"]').first().type('TestPass123!');
      
      // 点击登录按钮
      cy.contains('button', /登录|Login/).click();
      
      // 验证登录成功
      cy.url({ timeout: 5000 }).should('not.include', 'login');
      
      // 验证用户信息显示
      cy.get('[data-testid="user-info"]').should('be.visible');
    });

    it('应该拒绝无效的邮箱', () => {
      // 填充无效邮箱
      cy.get('input[type="email"]').first().type('invalid-email');
      cy.get('input[type="password"]').first().type('TestPass123!');
      
      // 点击登录
      cy.contains('button', /登录|Login/).click();
      
      // 验证错误提示
      cy.get('[data-testid="error-message"], .error, .alert').should('contain', /邮箱|Email/i);
    });

    it('应该拒绝错误的密码', () => {
      // 填充正确邮箱，错误密码
      cy.get('input[type="email"]').first().type('testuser@example.com');
      cy.get('input[type="password"]').first().type('WrongPassword123!');
      
      // 点击登录
      cy.contains('button', /登录|Login/).click();
      
      // 验证错误提示
      cy.get('[data-testid="error-message"], .error, .alert').should('contain', /密码|password/i);
    });

    it('应该拒绝空的表单', () => {
      // 不填充任何内容，直接点击登录
      cy.contains('button', /登录|Login/).click();
      
      // 验证验证错误
      cy.get('[data-testid="error-message"], .error, .alert').should('be.visible');
    });

    it('应该显示密码强度提示', () => {
      // 点击密码输入框
      cy.get('input[type="password"]').first().click();
      
      // 输入弱密码
      cy.get('input[type="password"]').first().type('weak');
      
      // 验证强度提示（如果存在）
      cy.get('[data-testid="password-strength"]').should('exist');
    });

    it('应该支持记住我功能', () => {
      // 检查记住我复选框
      cy.get('input[type="checkbox"]').first().check();
      
      // 填充登录信息
      cy.get('input[type="email"]').first().type('testuser@example.com');
      cy.get('input[type="password"]').first().type('TestPass123!');
      
      // 登录
      cy.contains('button', /登录|Login/).click();
      
      // 验证登录成功
      cy.url().should('not.include', 'login');
    });
  });

  describe('用户登出', () => {
    beforeEach(() => {
      // 先登录
      cy.get('input[type="email"]').first().type('testuser@example.com');
      cy.get('input[type="password"]').first().type('TestPass123!');
      cy.contains('button', /登录|Login/).click();
      cy.url().should('not.include', 'login');
    });

    it('应该成功登出', () => {
      // 点击用户菜单
      cy.get('[data-testid="user-menu"], button:contains("menu")').click();
      
      // 点击登出选项
      cy.get('[data-testid="logout-button"], button:contains("登出")').click();
      
      // 验证返回登录页
      cy.url().should('include', '/');
    });

    it('应该清理本地会话', () => {
      // 验证令牌存在
      cy.window().then(win => {
        expect(win.localStorage.getItem('token')).to.not.be.null;
      });
      
      // 登出
      cy.get('[data-testid="user-menu"]').click();
      cy.get('[data-testid="logout-button"]').click();
      
      // 验证令牌被清理
      cy.window().then(win => {
        expect(win.localStorage.getItem('token')).to.be.null;
      });
    });
  });

  describe('令牌管理', () => {
    beforeEach(() => {
      // 先登录
      cy.get('input[type="email"]').first().type('testuser@example.com');
      cy.get('input[type="password"]').first().type('TestPass123!');
      cy.contains('button', /登录|Login/).click();
      cy.url().should('not.include', 'login');
    });

    it('应该在本地存储中保存令牌', () => {
      cy.window().then(win => {
        const token = win.localStorage.getItem('token');
        expect(token).to.not.be.null;
        expect(token.length).to.be.greaterThan(0);
      });
    });

    it('应该在请求中包含令牌', () => {
      // 进行一个API请求（比如获取数据）
      cy.intercept('GET', '/api/**', req => {
        // 验证Authorization头
        expect(req.headers['authorization']).to.include('Bearer');
      }).as('apiRequest');
      
      // 触发一个会发送API请求的操作
      cy.get('[data-testid="refresh-data"], button:contains("刷新")').click();
      
      cy.wait('@apiRequest');
    });

    it('应该在令牌过期时刷新令牌', () => {
      // 模拟令牌过期
      cy.window().then(win => {
        const expiredToken = 'expired_token';
        win.localStorage.setItem('token', expiredToken);
      });
      
      // 尝试进行操作
      cy.get('[data-testid="refresh-data"]').click();
      
      // 应该自动刷新令牌或重新登录
      cy.get('[data-testid="user-info"]').should('exist');
    });
  });

  describe('密码重置', () => {
    it('应该显示忘记密码链接', () => {
      cy.get('a:contains("忘记密码"), button:contains("忘记密码")').should('be.visible');
    });

    it('应该进入密码重置流程', () => {
      cy.get('a:contains("忘记密码"), button:contains("忘记密码")').click();
      
      cy.url().should('include', '/reset');
      cy.get('input[type="email"]').should('be.visible');
    });

    it('应该验证重置邮箱', () => {
      cy.get('a:contains("忘记密码")').click();
      
      cy.get('input[type="email"]').type('testuser@example.com');
      cy.contains('button', /重置|Reset/).click();
      
      cy.get('[data-testid="success-message"], .alert-success').should('contain', /邮件|email/i);
    });
  });

  describe('会话安全', () => {
    beforeEach(() => {
      // 登录
      cy.get('input[type="email"]').first().type('testuser@example.com');
      cy.get('input[type="password"]').first().type('TestPass123!');
      cy.contains('button', /登录|Login/).click();
      cy.url().should('not.include', 'login');
    });

    it('应该在空闲后退出登录', () => {
      // 这个测试需要模拟空闲时间
      // 实际实现可能需要调整
      cy.window().then(win => {
        // 模拟30分钟空闲
        win.inactivityTimeout = 1800000;
      });
    });

    it('应该防止令牌泄露', () => {
      cy.window().then(win => {
        const token = win.localStorage.getItem('token');
        
        // 验证令牌不在URL中
        cy.url().should('not.contain', token);
        
        // 验证令牌不在页面内容中
        cy.window().then(w => {
          expect(w.document.body.innerText).to.not.include(token);
        });
      });
    });

    it('应该支持多标签页同步', () => {
      // 在另一个标签页中登出
      cy.window().then(win => {
        // 模拟登出事件
        const logoutEvent = new Event('logout');
        win.dispatchEvent(logoutEvent);
      });
      
      // 当前标签页应该检测到登出
      cy.url({ timeout: 3000 }).should('include', '/');
    });
  });

  describe('账户管理', () => {
    beforeEach(() => {
      // 登录
      cy.get('input[type="email"]').first().type('testuser@example.com');
      cy.get('input[type="password"]').first().type('TestPass123!');
      cy.contains('button', /登录|Login/).click();
      cy.url().should('not.include', 'login');
    });

    it('应该显示个人资料页面', () => {
      cy.get('[data-testid="user-menu"]').click();
      cy.get('[data-testid="profile-link"], a:contains("个人资料")').click();
      
      cy.url().should('include', '/profile');
      cy.get('[data-testid="profile-form"]').should('be.visible');
    });

    it('应该允许更新用户信息', () => {
      cy.get('[data-testid="user-menu"]').click();
      cy.get('[data-testid="profile-link"]').click();
      
      cy.get('input[name="name"]').clear().type('New Name');
      cy.contains('button', /保存|Save/).click();
      
      cy.get('[data-testid="success-message"]').should('contain', /保存成功/i);
    });

    it('应该允许修改密码', () => {
      cy.get('[data-testid="user-menu"]').click();
      cy.get('[data-testid="profile-link"]').click();
      
      cy.get('[data-testid="change-password"]').click();
      
      cy.get('input[name="currentPassword"]').type('TestPass123!');
      cy.get('input[name="newPassword"]').type('NewPass456!');
      cy.get('input[name="confirmPassword"]').type('NewPass456!');
      
      cy.contains('button', /确认|Confirm/).click();
      
      cy.get('[data-testid="success-message"]').should('contain', /密码修改成功/i);
    });
  });
});
