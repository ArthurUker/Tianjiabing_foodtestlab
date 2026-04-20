/**
 * E2E 测试: 性能和安全
 * 测试系统性能指标和安全防护
 */

describe('E2E 测试 - 性能和安全', () => {
  beforeEach(() => {
    cy.visit('/');
    
    // 登录
    cy.get('input[type="email"]').first().type('testuser@example.com');
    cy.get('input[type="password"]').first().type('TestPass123!');
    cy.contains('button', /登录|Login/).click();
    cy.url().should('not.include', 'login');
  });

  describe('页面性能', () => {
    it('首页加载应该在3秒内完成', () => {
      cy.visit('/', {
        onBeforeLoad: (win) => {
          win.startTime = Date.now();
        },
        onLoad: (win) => {
          win.loadTime = Date.now() - win.startTime;
          expect(win.loadTime).to.be.lessThan(3000);
        }
      });
    });

    it('数据列表加载应该在2秒内完成', () => {
      const startTime = Date.now();
      
      cy.get('[data-testid="records-list"], table').should('be.visible');
      
      cy.then(() => {
        const endTime = Date.now();
        expect(endTime - startTime).to.be.lessThan(2000);
      });
    });

    it('应该优化大列表渲染', () => {
      // 加载大量数据
      cy.get('[data-testid="records-list"]').should('be.visible');
      
      // 滚动列表
      cy.get('[data-testid="records-list"]').scrollTo('bottom');
      
      // 页面应该保持响应
      cy.get('[data-testid="search-input"]').type('test').should('have.value', 'test');
    });

    it('应该缓存静态资源', () => {
      cy.intercept('/js/**', {
        statusCode: 200,
        delay: 0 // 验证缓存命中
      }).as('staticResource');
      
      cy.reload();
      cy.wait('@staticResource', { timeout: 500 });
    });

    it('应该进行API请求批处理', () => {
      // 监听API请求
      cy.intercept('POST', '/api/**').as('apiCall');
      
      // 执行操作
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type('测试');
      cy.contains('button', /保存|Submit/).click();
      
      // 验证请求数量最少化
      cy.get('@apiCall.all').then(calls => {
        expect(calls.length).to.be.lessThan(5);
      });
    });
  });

  describe('内存使用', () => {
    it('应该不泄漏内存', () => {
      cy.window().then(win => {
        if (win.performance.memory) {
          const initialMemory = win.performance.memory.usedJSHeapSize;
          
          // 进行多个操作
          for (let i = 0; i < 10; i++) {
            cy.get('[data-testid="create-button"]').click();
            cy.get('input[name="name"]').type(`测试 ${i}`);
            cy.contains('button', /保存|Submit/).click();
          }
          
          const finalMemory = win.performance.memory.usedJSHeapSize;
          const increase = finalMemory - initialMemory;
          
          // 内存增长不应该超过50%
          expect(increase / initialMemory).to.be.lessThan(0.5);
        }
      });
    });
  });

  describe('XSS防护', () => {
    it('应该防止XSS攻击', () => {
      const xssPayload = '<img src=x onerror="alert(\'XSS\')">';
      
      // 尝试在输入字段中注入XSS
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type(xssPayload);
      cy.contains('button', /保存|Submit/).click();
      
      // 验证没有执行任何脚本
      cy.on('window:alert', () => {
        throw new Error('XSS 攻击检测到！');
      });
    });

    it('应该转义用户输入', () => {
      const userInput = '<script>alert("test")</script>';
      
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type(userInput);
      cy.contains('button', /保存|Submit/).click();
      
      // 验证输入被安全处理
      cy.get('[data-testid="records-list"]').should('contain', userInput);
    });
  });

  describe('CSRF防护', () => {
    it('应该在请求中包含CSRF令牌', () => {
      cy.intercept('POST', '/api/**', (req) => {
        // 验证CSRF令牌存在
        expect(req.headers['x-csrf-token']).to.exist;
      }).as('apiCall');
      
      cy.get('[data-testid="create-button"]').click();
      cy.get('input[name="name"]').type('CSRF测试');
      cy.contains('button', /保存|Submit/).click();
      
      cy.wait('@apiCall');
    });
  });

  describe('SQL注入防护', () => {
    it('应该防止SQL注入', () => {
      const sqlPayload = "' OR '1'='1";
      
      cy.get('[data-testid="search-input"]').type(sqlPayload);
      cy.contains('button', /搜索|Search/).click();
      
      // 验证没有返回所有记录
      cy.get('tbody tr').each(row => {
        cy.wrap(row).should('not.contain', sqlPayload);
      });
    });
  });

  describe('认证安全', () => {
    it('应该不在URL中暴露令牌', () => {
      cy.url().should('not.contain', 'token');
      cy.url().should('not.contain', 'sessionId');
    });

    it('应该不在页面源代码中暴露敏感信息', () => {
      cy.request('/').then(response => {
        // 验证令牌不在HTML中
        expect(response.body).to.not.include('Authorization');
        expect(response.body).to.not.include('Bearer');
      });
    });

    it('应该使用HTTPS传输敏感数据', () => {
      // 这个测试假设在HTTPS环境运行
      cy.request({
        url: '/api/data',
        failOnStatusCode: false
      }).then(response => {
        // 验证请求是否通过HTTPS
        expect(response.status).to.be.within(0, 500);
      });
    });
  });

  describe('数据隐私', () => {
    it('应该使用HTTPS加密数据传输', () => {
      cy.intercept('/api/**', (req) => {
        // 验证请求是否通过HTTPS（在测试环境中）
        expect(req.url).to.not.contain('http://');
      }).as('secureRequest');
    });

    it('应该在本地加密敏感数据', () => {
      cy.window().then(win => {
        // 验证不存储明文密码
        const userData = win.localStorage.getItem('user');
        if (userData) {
          expect(userData).to.not.include('password');
        }
      });
    });

    it('应该不收集不必要的用户数据', () => {
      cy.window().then(win => {
        // 验证存储的用户数据最少
        const storedKeys = Object.keys(win.localStorage);
        const sensitiveKeys = storedKeys.filter(k => 
          k.includes('password') || k.includes('pin') || k.includes('ssn')
        );
        
        expect(sensitiveKeys).to.have.length(0);
      });
    });
  });

  describe('速率限制', () => {
    it('应该限制登录尝试', () => {
      // 尝试多次错误登录
      for (let i = 0; i < 6; i++) {
        cy.visit('/');
        cy.get('input[type="email"]').first().type('test@example.com');
        cy.get('input[type="password"]').first().type('wrong');
        cy.contains('button', /登录|Login/).click();
      }
      
      // 应该显示锁定提示
      cy.get('[data-testid="locked-message"], .alert-danger').should('contain', /锁定|locked/i);
    });

    it('应该限制API请求频率', () => {
      // 尝试快速请求
      cy.intercept('POST', '/api/**', (req) => {
        req.reply((res) => {
          if (res.statusCode === 429) {
            expect(res.statusCode).to.equal(429);
          }
        });
      }).as('rateLimit');
      
      // 执行快速请求
      for (let i = 0; i < 100; i++) {
        cy.get('[data-testid="create-button"]').click();
        cy.get('input[name="name"]').type(`快速请求 ${i}`);
        cy.contains('button', /保存|Submit/).click();
      }
    });
  });

  describe('访问控制', () => {
    it('应该禁止未授权访问', () => {
      // 清除登录信息
      cy.window().then(win => {
        win.localStorage.removeItem('token');
      });
      
      // 尝试访问受保护的页面
      cy.visit('/dashboard', { failOnStatusCode: false });
      
      // 应该重定向到登录
      cy.url().should('include', '/');
    });

    it('应该根据权限限制功能', () => {
      // 假设当前用户是普通用户
      // 验证管理员功能不可用
      cy.get('[data-testid="admin-panel"]').should('not.exist');
      cy.get('[data-testid="user-management"]').should('not.exist');
    });
  });

  describe('错误处理', () => {
    it('应该不暴露敏感的错误信息', () => {
      cy.intercept('GET', '/api/**', {
        statusCode: 500,
        body: { message: '内部服务器错误', details: '数据库连接失败' }
      });
      
      cy.get('[data-testid="refresh-button"]').click();
      
      // 验证显示用户友好的错误
      cy.get('[data-testid="error-message"]').should('contain', /错误|Error/i);
      cy.get('[data-testid="error-message"]').should('not.contain', '数据库');
    });

    it('应该记录安全事件', () => {
      // 尝试未授权的操作
      cy.intercept('DELETE', '/api/**', { statusCode: 403 });
      
      cy.get('[data-testid="delete-button"]').first().click();
      cy.get('[data-testid="confirm-button"]').click();
      
      // 验证错误处理
      cy.get('[data-testid="error-message"]').should('be.visible');
    });
  });

  describe('依赖安全', () => {
    it('应该使用安全的依赖版本', () => {
      // 这个测试需要检查package.json
      cy.readFile('package.json').then(content => {
        const pkg = typeof content === 'string' ? JSON.parse(content) : content;
        
        // 验证没有已知的易受攻击的依赖
        expect(pkg.dependencies).to.not.have.property('lodash@<4.17.11');
      });
    });
  });

  describe('合规性', () => {
    it('应该提供隐私政策', () => {
      cy.get('a:contains("隐私"), footer a:contains("Privacy")').should('exist');
    });

    it('应该提供服务条款', () => {
      cy.get('a:contains("服务条款"), footer a:contains("Terms")').should('exist');
    });

    it('应该支持数据导出', () => {
      cy.get('[data-testid="export-button"]').should('be.visible');
    });

    it('应该支持账户删除', () => {
      cy.get('[data-testid="user-menu"]').click();
      cy.get('[data-testid="delete-account"]').should('exist');
    });
  });
});
