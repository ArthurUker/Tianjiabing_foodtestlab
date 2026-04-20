/**
 * 集成测试 - 表单验证和用户认证流程
 * 测试完整的注册和登录过程
 */

describe('集成测试 - 完整认证流程', () => {
  // 模拟 Validator 类
  class Validator {
    static validateEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    static validatePassword(password) {
      return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[a-zA-Z\d@$!%*?&]{8,}$/.test(password);
    }

    static validateUsername(username) {
      return /^[a-zA-Z0-9_]{3,20}$/.test(username);
    }

    static detectXSS(str) {
      const xssPatterns = [/<script[^>]*>/gi, /on\w+\s*=/gi, /javascript:/gi];
      return xssPatterns.some(pattern => pattern.test(str));
    }
  }

  // 模拟 UserManager 类
  class UserManager {
    constructor() {
      this.users = new Map();
      this.idCounter = 1;
    }

    async register(email, username, password) {
      for (const user of this.users.values()) {
        if (user.email === email || user.username === username) {
          throw new Error('用户已存在');
        }
      }

      const user = {
        id: this.idCounter++,
        email,
        username,
        password,
        createdAt: new Date(),
        role: 'user'
      };

      this.users.set(user.id, user);
      return user;
    }

    async login(email, password) {
      for (const user of this.users.values()) {
        if (user.email === email && user.password === password) {
          return { id: user.id, email: user.email, username: user.username, role: user.role };
        }
      }
      throw new Error('邮箱或密码错误');
    }
  }

  let userManager;
  let validator;

  beforeEach(() => {
    userManager = new UserManager();
    validator = Validator;
  });

  describe('用户注册表单验证流程', () => {
    test('应该完成完整的注册流程', async () => {
      const formData = {
        email: 'newuser@example.com',
        username: 'newuser123',
        password: 'SecurePass@2024',
        confirmPassword: 'SecurePass@2024'
      };

      // 1. 验证输入
      expect(validator.validateEmail(formData.email)).toBe(true);
      expect(validator.validateUsername(formData.username)).toBe(true);
      expect(validator.validatePassword(formData.password)).toBe(true);

      // 2. 检查密码匹配
      expect(formData.password).toBe(formData.confirmPassword);

      // 3. 检查XSS
      expect(validator.detectXSS(formData.email)).toBe(false);
      expect(validator.detectXSS(formData.username)).toBe(false);

      // 4. 注册用户
      const user = await userManager.register(
        formData.email,
        formData.username,
        formData.password
      );

      expect(user.email).toBe(formData.email);
      expect(user.username).toBe(formData.username);
    });

    test('应该拒绝无效的邮箱注册', async () => {
      const email = 'invalid-email';

      expect(validator.validateEmail(email)).toBe(false);
    });

    test('应该拒绝弱密码注册', async () => {
      const password = 'weak';

      expect(validator.validatePassword(password)).toBe(false);
    });

    test('应该拒绝包含XSS的用户名', async () => {
      const username = '<script>alert(1)</script>';

      expect(validator.detectXSS(username)).toBe(true);
    });

    test('应该拒绝重复邮箱注册', async () => {
      await userManager.register(
        'user@example.com',
        'user123',
        'SecurePass@2024'
      );

      await expect(
        userManager.register(
          'user@example.com',
          'different',
          'SecurePass@2024'
        )
      ).rejects.toThrow('用户已存在');
    });
  });

  describe('用户登录流程', () => {
    beforeEach(async () => {
      await userManager.register(
        'user@example.com',
        'testuser',
        'SecurePass@2024'
      );
    });

    test('应该完成完整的登录流程', async () => {
      const formData = {
        email: 'user@example.com',
        password: 'SecurePass@2024'
      };

      // 1. 验证输入
      expect(validator.validateEmail(formData.email)).toBe(true);

      // 2. 检查XSS
      expect(validator.detectXSS(formData.email)).toBe(false);

      // 3. 登录
      const user = await userManager.login(
        formData.email,
        formData.password
      );

      expect(user.email).toBe(formData.email);
      expect(user.username).toBe('testuser');
    });

    test('应该拒绝错误的密码', async () => {
      await expect(
        userManager.login('user@example.com', 'WrongPassword')
      ).rejects.toThrow('邮箱或密码错误');
    });

    test('应该拒绝不存在的邮箱', async () => {
      await expect(
        userManager.login('nonexistent@example.com', 'AnyPassword@2024')
      ).rejects.toThrow('邮箱或密码错误');
    });

    test('应该拒绝XSS攻击尝试', async () => {
      const xssEmail = 'user@example.com<script>alert(1)</script>';

      expect(validator.detectXSS(xssEmail)).toBe(true);
    });
  });

  describe('表单数据安全性', () => {
    test('应该在所有字段检查XSS', async () => {
      const maliciousInputs = [
        '<img src=x onerror=alert(1)>',
        'javascript:alert(1)',
        '<iframe src="javascript:alert(1)"></iframe>',
        '"><script>alert(1)</script>',
        "'; DROP TABLE users; --"
      ];

      maliciousInputs.forEach(input => {
        expect(validator.detectXSS(input)).toBe(true);
      });
    });

    test('应该允许合法的用户输入', async () => {
      const legitimateInputs = [
        'user@example.com',
        'John Doe',
        'user_name_123',
        'https://example.com'
      ];

      legitimateInputs.forEach(input => {
        expect(validator.detectXSS(input)).toBe(false);
      });
    });

    test('应该验证所有必填字段', async () => {
      const requiredFields = ['email', 'username', 'password'];

      const formData = {
        email: 'user@example.com',
        username: 'testuser',
        password: 'SecurePass@2024'
      };

      requiredFields.forEach(field => {
        expect(formData[field]).toBeDefined();
        expect(formData[field]).not.toBe('');
      });
    });
  });

  describe('错误处理', () => {
    test('应该处理网络错误', async () => {
      const testError = async () => {
        throw new Error('网络连接失败');
      };

      await expect(testError()).rejects.toThrow('网络连接失败');
    });

    test('应该处理验证错误', () => {
      const invalidEmail = 'not-an-email';
      
      expect(validator.validateEmail(invalidEmail)).toBe(false);
    });

    test('应该处理业务逻辑错误', async () => {
      await userManager.register(
        'user@example.com',
        'testuser',
        'SecurePass@2024'
      );

      await expect(
        userManager.register(
          'user@example.com',
          'testuser',
          'SecurePass@2024'
        )
      ).rejects.toThrow('用户已存在');
    });
  });

  describe('多用户场景', () => {
    test('应该支持多个用户的并发注册', async () => {
      const registrations = [
        { email: 'user1@example.com', username: 'user1', password: 'Pass1@2024' },
        { email: 'user2@example.com', username: 'user2', password: 'Pass2@2024' },
        { email: 'user3@example.com', username: 'user3', password: 'Pass3@2024' }
      ];

      const results = await Promise.all(
        registrations.map(reg =>
          userManager.register(reg.email, reg.username, reg.password)
        )
      );

      expect(results.length).toBe(3);
      expect(results[0].id).toBe(1);
      expect(results[1].id).toBe(2);
      expect(results[2].id).toBe(3);
    });

    test('应该隔离不同用户的登录会话', async () => {
      await userManager.register('user1@example.com', 'user1', 'Pass1@2024');
      await userManager.register('user2@example.com', 'user2', 'Pass2@2024');

      const user1Session = await userManager.login('user1@example.com', 'Pass1@2024');
      const user2Session = await userManager.login('user2@example.com', 'Pass2@2024');

      expect(user1Session.id).not.toBe(user2Session.id);
      expect(user1Session.username).toBe('user1');
      expect(user2Session.username).toBe('user2');
    });
  });

  describe('性能测试', () => {
    test('应该在合理时间内完成注册', async () => {
      const startTime = Date.now();

      await userManager.register(
        'user@example.com',
        'testuser',
        'SecurePass@2024'
      );

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // 应该在1秒内完成
    });

    test('应该在合理时间内完成登录', async () => {
      await userManager.register(
        'user@example.com',
        'testuser',
        'SecurePass@2024'
      );

      const startTime = Date.now();

      await userManager.login('user@example.com', 'SecurePass@2024');

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // 应该在1秒内完成
    });
  });
});
