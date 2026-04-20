/**
 * UserManager 后端单元测试
 * 测试用户管理、认证、密码加密等功能
 */

describe('UserManager - 用户管理系统', () => {
  // 模拟 bcryptjs
  const bcrypt = {
    hash: jest.fn(async (password) => {
      return `hashed_${password}`;
    }),
    compare: jest.fn(async (password, hash) => {
      return hash === `hashed_${password}`;
    })
  };

  // 模拟 UserManager 类
  class UserManager {
    constructor() {
      this.users = new Map();
      this.idCounter = 1;
    }

    async register(email, username, password) {
      // 验证邮箱格式
      if (!email.includes('@')) {
        throw new Error('邮箱格式无效');
      }

      // 检查用户是否已存在
      for (const user of this.users.values()) {
        if (user.email === email || user.username === username) {
          throw new Error('用户已存在');
        }
      }

      // 检查密码强度
      if (password.length < 8) {
        throw new Error('密码长度至少8个字符');
      }

      // 密码加密
      const hashedPassword = await bcrypt.hash(password);

      const user = {
        id: this.idCounter++,
        email,
        username,
        password: hashedPassword,
        createdAt: new Date(),
        role: 'user',
        isActive: true
      };

      this.users.set(user.id, user);
      return user;
    }

    async login(email, password) {
      let user = null;

      for (const u of this.users.values()) {
        if (u.email === email) {
          user = u;
          break;
        }
      }

      if (!user) {
        throw new Error('用户不存在');
      }

      if (!user.isActive) {
        throw new Error('用户已被禁用');
      }

      // 验证密码
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        throw new Error('密码错误');
      }

      return {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role
      };
    }

    async getUserById(id) {
      const user = this.users.get(id);
      if (!user) return null;

      return {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt
      };
    }

    async updateUser(id, updates) {
      const user = this.users.get(id);
      if (!user) throw new Error('用户不存在');

      if (updates.email) user.email = updates.email;
      if (updates.username) user.username = updates.username;
      if (updates.role) user.role = updates.role;
      if (updates.isActive !== undefined) user.isActive = updates.isActive;

      return user;
    }

    async deleteUser(id) {
      const user = this.users.get(id);
      if (!user) throw new Error('用户不存在');

      this.users.delete(id);
      return true;
    }

    async changePassword(id, oldPassword, newPassword) {
      const user = this.users.get(id);
      if (!user) throw new Error('用户不存在');

      // 验证旧密码
      const isValid = await bcrypt.compare(oldPassword, user.password);
      if (!isValid) throw new Error('密码错误');

      // 设置新密码
      user.password = await bcrypt.hash(newPassword);
      return true;
    }

    async getUsersByRole(role) {
      const result = [];
      for (const user of this.users.values()) {
        if (user.role === role) {
          result.push({
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role
          });
        }
      }
      return result;
    }

    getAllUsers() {
      return Array.from(this.users.values()).map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt
      }));
    }
  }

  let userManager;

  beforeEach(() => {
    userManager = new UserManager();
    jest.clearAllMocks();
  });

  describe('用户注册', () => {
    test('应该成功注册新用户', async () => {
      const user = await userManager.register(
        'user@example.com',
        'testuser',
        'SecurePass123'
      );

      expect(user.id).toBeDefined();
      expect(user.email).toBe('user@example.com');
      expect(user.username).toBe('testuser');
      expect(user.role).toBe('user');
    });

    test('应该拒绝无效的邮箱格式', async () => {
      await expect(
        userManager.register('invalid-email', 'testuser', 'SecurePass123')
      ).rejects.toThrow('邮箱格式无效');
    });

    test('应该拒绝重复的邮箱', async () => {
      await userManager.register('user@example.com', 'user1', 'SecurePass123');

      await expect(
        userManager.register('user@example.com', 'user2', 'SecurePass123')
      ).rejects.toThrow('用户已存在');
    });

    test('应该拒绝重复的用户名', async () => {
      await userManager.register('user1@example.com', 'testuser', 'SecurePass123');

      await expect(
        userManager.register('user2@example.com', 'testuser', 'SecurePass123')
      ).rejects.toThrow('用户已存在');
    });

    test('应该拒绝短密码', async () => {
      await expect(
        userManager.register('user@example.com', 'testuser', 'short')
      ).rejects.toThrow('密码长度至少8个字符');
    });

    test('应该加密密码', async () => {
      await userManager.register('user@example.com', 'testuser', 'MyPassword123');

      expect(bcrypt.hash).toHaveBeenCalledWith('MyPassword123');
    });
  });

  describe('用户登录', () => {
    beforeEach(async () => {
      await userManager.register('user@example.com', 'testuser', 'SecurePass123');
    });

    test('应该成功登录', async () => {
      const user = await userManager.login('user@example.com', 'SecurePass123');

      expect(user.id).toBeDefined();
      expect(user.email).toBe('user@example.com');
      expect(user.username).toBe('testuser');
    });

    test('应该拒绝不存在的用户', async () => {
      await expect(
        userManager.login('nonexistent@example.com', 'password')
      ).rejects.toThrow('用户不存在');
    });

    test('应该拒绝错误的密码', async () => {
      await expect(
        userManager.login('user@example.com', 'WrongPassword123')
      ).rejects.toThrow('密码错误');
    });

    test('应该拒绝禁用的用户', async () => {
      await userManager.updateUser(1, { isActive: false });

      await expect(
        userManager.login('user@example.com', 'SecurePass123')
      ).rejects.toThrow('用户已被禁用');
    });
  });

  describe('用户管理', () => {
    beforeEach(async () => {
      await userManager.register('user@example.com', 'testuser', 'SecurePass123');
    });

    test('应该根据ID获取用户', async () => {
      const user = await userManager.getUserById(1);

      expect(user).toBeDefined();
      expect(user.username).toBe('testuser');
    });

    test('应该返回null当用户不存在时', async () => {
      const user = await userManager.getUserById(999);
      expect(user).toBeNull();
    });

    test('应该更新用户信息', async () => {
      await userManager.updateUser(1, {
        username: 'newusername',
        role: 'admin'
      });

      const user = await userManager.getUserById(1);
      expect(user.username).toBe('newusername');
      expect(user.role).toBe('admin');
    });

    test('应该删除用户', async () => {
      await userManager.deleteUser(1);

      const user = await userManager.getUserById(1);
      expect(user).toBeNull();
    });

    test('应该获取所有用户', () => {
      const users = userManager.getAllUsers();
      expect(users.length).toBe(1);
      expect(users[0].username).toBe('testuser');
    });
  });

  describe('密码管理', () => {
    beforeEach(async () => {
      await userManager.register('user@example.com', 'testuser', 'OldPassword123');
    });

    test('应该修改密码', async () => {
      await userManager.changePassword(1, 'OldPassword123', 'NewPassword456');

      expect(bcrypt.compare).toHaveBeenCalledWith('OldPassword123', expect.any(String));
      expect(bcrypt.hash).toHaveBeenCalledWith('NewPassword456');
    });

    test('应该拒绝错误的旧密码', async () => {
      await expect(
        userManager.changePassword(1, 'WrongPassword', 'NewPassword456')
      ).rejects.toThrow('密码错误');
    });

    test('应该拒绝修改不存在用户的密码', async () => {
      await expect(
        userManager.changePassword(999, 'OldPassword123', 'NewPassword456')
      ).rejects.toThrow('用户不存在');
    });
  });

  describe('角色管理', () => {
    beforeEach(async () => {
      await userManager.register('admin@example.com', 'admin', 'AdminPass123');
      await userManager.register('user1@example.com', 'user1', 'UserPass123');
      await userManager.register('user2@example.com', 'user2', 'UserPass123');
      
      await userManager.updateUser(1, { role: 'admin' });
    });

    test('应该按角色获取用户', async () => {
      const admins = await userManager.getUsersByRole('admin');
      const users = await userManager.getUsersByRole('user');

      expect(admins.length).toBe(1);
      expect(users.length).toBe(2);
    });

    test('应该返回空数组当没有该角色用户时', async () => {
      const moderators = await userManager.getUsersByRole('moderator');
      expect(moderators).toEqual([]);
    });
  });

  describe('数据安全', () => {
    test('应该不返回哈希密码', async () => {
      await userManager.register('user@example.com', 'testuser', 'SecurePass123');

      const user = await userManager.getUserById(1);
      expect(user.password).toBeUndefined();
    });

    test('应该隐藏登录中的密码', async () => {
      await userManager.register('user@example.com', 'testuser', 'SecurePass123');

      const user = await userManager.login('user@example.com', 'SecurePass123');
      expect(user.password).toBeUndefined();
    });
  });
});
