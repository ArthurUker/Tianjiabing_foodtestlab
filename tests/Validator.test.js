/**
 * Validator 单元测试
 * 测试所有验证规则和安全防护
 */

describe('Validator - 输入验证和防护', () => {
  // 模拟 Validator 类
  class Validator {
    static rules = {
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      username: /^[a-zA-Z0-9_]{3,20}$/,
      password: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[a-zA-Z\d@$!%*?&]{8,}$/,
      phone: /^1[3-9]\d{9}$/,
      url: /^https?:\/\/.+/,
    };

    static validateEmail(email) {
      return this.rules.email.test(email);
    }

    static validateUsername(username) {
      return this.rules.username.test(username);
    }

    static validatePassword(password) {
      return this.rules.password.test(password);
    }

    static validatePhone(phone) {
      return this.rules.phone.test(phone);
    }

    static escapeHtml(str) {
      const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return str.replace(/[&<>"']/g, m => map[m]);
    }

    static detectXSS(str) {
      const xssPatterns = [
        /<script[^>]*>/gi,
        /on\w+\s*=/gi,
        /javascript:/gi,
      ];
      return xssPatterns.some(pattern => pattern.test(str));
    }

    static detectSQLInjection(str) {
      const sqlPatterns = [
        /(\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|SCRIPT)\b)/gi,
        /(-{2}|\/\*|\*\/|;|'|\")/g,
      ];
      return sqlPatterns.some(pattern => pattern.test(str));
    }
  }

  describe('邮箱验证', () => {
    test('应该验证有效的邮箱地址', () => {
      expect(Validator.validateEmail('user@example.com')).toBe(true);
      expect(Validator.validateEmail('test.email@company.co.uk')).toBe(true);
    });

    test('应该拒绝无效的邮箱地址', () => {
      expect(Validator.validateEmail('invalid-email')).toBe(false);
      expect(Validator.validateEmail('user@')).toBe(false);
      expect(Validator.validateEmail('@example.com')).toBe(false);
    });

    test('应该处理空字符串', () => {
      expect(Validator.validateEmail('')).toBe(false);
    });
  });

  describe('用户名验证', () => {
    test('应该验证有效的用户名', () => {
      expect(Validator.validateUsername('user123')).toBe(true);
      expect(Validator.validateUsername('john_doe')).toBe(true);
    });

    test('应该拒绝短于3个字符的用户名', () => {
      expect(Validator.validateUsername('ab')).toBe(false);
    });

    test('应该拒绝包含特殊字符的用户名', () => {
      expect(Validator.validateUsername('user@123')).toBe(false);
      expect(Validator.validateUsername('user-name')).toBe(false);
    });
  });

  describe('密码验证', () => {
    test('应该验证强密码', () => {
      expect(Validator.validatePassword('SecurePass123!')).toBe(true);
      expect(Validator.validatePassword('MyPassword@2024')).toBe(true);
    });

    test('应该拒绝弱密码', () => {
      expect(Validator.validatePassword('weak')).toBe(false);
      expect(Validator.validatePassword('12345678')).toBe(false);
      expect(Validator.validatePassword('NoNumber!')).toBe(false);
    });

    test('应该拒绝短于8个字符的密码', () => {
      expect(Validator.validatePassword('Short1!')).toBe(false);
    });
  });

  describe('电话号码验证', () => {
    test('应该验证有效的中国手机号', () => {
      expect(Validator.validatePhone('13800138000')).toBe(true);
      expect(Validator.validatePhone('15900001111')).toBe(true);
    });

    test('应该拒绝无效的电话号码', () => {
      expect(Validator.validatePhone('12345678901')).toBe(false);
      expect(Validator.validatePhone('1230123')).toBe(false);
    });
  });

  describe('XSS防护 - HTML转义', () => {
    test('应该转义危险的HTML字符', () => {
      expect(Validator.escapeHtml('<script>alert("xss")</script>'))
        .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    test('应该转义所有特殊字符', () => {
      expect(Validator.escapeHtml('&<>"\''))
        .toBe('&amp;&lt;&gt;&quot;&#39;');
    });

    test('应该保留普通文本', () => {
      expect(Validator.escapeHtml('Hello World'))
        .toBe('Hello World');
    });
  });

  describe('XSS防护 - 检测', () => {
    test('应该检测script标签', () => {
      expect(Validator.detectXSS('<script>alert(1)</script>')).toBe(true);
      expect(Validator.detectXSS('<SCRIPT>alert(1)</SCRIPT>')).toBe(true);
    });

    test('应该检测事件处理器', () => {
      expect(Validator.detectXSS('onclick=alert(1)')).toBe(true);
      expect(Validator.detectXSS('onload=alert(1)')).toBe(true);
    });

    test('应该检测javascript协议', () => {
      expect(Validator.detectXSS('javascript:alert(1)')).toBe(true);
    });

    test('应该允许安全内容', () => {
      expect(Validator.detectXSS('Hello world')).toBe(false);
      expect(Validator.detectXSS('https://example.com')).toBe(false);
    });
  });

  describe('SQL注入防护', () => {
    test('应该检测常见SQL关键字', () => {
      expect(Validator.detectSQLInjection("' OR '1'='1")).toBe(true);
      expect(Validator.detectSQLInjection("admin' --")).toBe(true);
      expect(Validator.detectSQLInjection("DROP TABLE users")).toBe(true);
    });

    test('应该检测SQL注释符', () => {
      expect(Validator.detectSQLInjection('/* comment */')).toBe(true);
      expect(Validator.detectSQLInjection('admin--')).toBe(true);
    });

    test('应该允许安全的用户输入', () => {
      expect(Validator.detectSQLInjection('username123')).toBe(false);
      expect(Validator.detectSQLInjection('John Doe')).toBe(false);
    });
  });

  describe('综合验证', () => {
    test('应该正确处理多个验证规则', () => {
      const validData = {
        email: 'user@example.com',
        username: 'user123',
        password: 'SecurePass123!',
        phone: '13800138000'
      };

      expect(Validator.validateEmail(validData.email)).toBe(true);
      expect(Validator.validateUsername(validData.username)).toBe(true);
      expect(Validator.validatePassword(validData.password)).toBe(true);
      expect(Validator.validatePhone(validData.phone)).toBe(true);
    });

    test('应该批量检测安全威胁', () => {
      const threatContent = [
        '<script>alert(1)</script>',
        "admin' OR '1'='1",
        'onclick=alert(1)',
        'DROP TABLE users'
      ];

      threatContent.forEach(content => {
        expect(Validator.detectXSS(content) || Validator.detectSQLInjection(content))
          .toBe(true);
      });
    });
  });
});
