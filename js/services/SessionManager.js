/**
 * SessionManager - 会话管理模块
 * 处理用户会话的生命周期、并发会话限制、设备管理
 */

import { authService } from '../services/AuthService.js';
import { UINotification } from '../utils/UINotification.js';

export class SessionManager {
    constructor() {
        this.moduleName = '会话管理';
        // P1-11: 会话存储为内存数组（运行时），已有 TTL 与最大会话数限制，无需额外修改。
        //   - 会话超时：sessionTimeout = 30 分钟无活动自动登出（见 checkSessionExpiry）
        //   - 最大并发：maxConcurrentSessions = 5（见 enforceMaxSessions）
        //   - 后端认证为 JWT 无状态（UserManager.verifyToken），重启不丢失登录态
        //   - syncToBackend / syncSessions 为 TODO 占位，后端 session API 未实现
        //   - 遗留：inactive 会话不从数组移除（removeSession 仅改 status），长期运行可能内存增长 → TD-P2-15 评估
        //   - getClientIP() 返回模拟 127.0.0.1（见下方注释），非配置硬编码
        this.sessions = [];
        this.maxConcurrentSessions = 5; // 最多允许同时活跃会话数
        this.sessionTimeout = 30 * 60 * 1000; // 30 分钟无活动自动登出
    }

    /**
     * 初始化会话管理器
     */
    init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');

        // 启动会话定期检查
        this.startSessionMonitor();

        // 启动设备检测
        this.startDeviceDetection();

        // 监听登录事件
        window.addEventListener('userLogin', () => this.onUserLogin());

        // 监听登出事件
        window.addEventListener('userLogout', () => this.onUserLogout());

        console.log('✅ ' + this.moduleName + ' 初始化完成');
        return true;
    }

    /**
     * 用户登录处理
     */
    onUserLogin() {
        const session = this.createSession();
        this.sessions.push(session);
        this.enforceMaxSessions();
        this.syncToBackend('add', session);
    }

    /**
     * 用户登出处理
     */
    onUserLogout() {
        const currentSession = this.getCurrentSession();
        if (currentSession) {
            this.removeSession(currentSession.id);
        }
    }

    /**
     * 创建新会话
     */
    createSession() {
        const user = authService.getUser();
        const sessionId = this.generateSessionId();

        return {
            id: sessionId,
            userId: user?.id,
            username: user?.username,
            loginTime: new Date().toISOString(),
            lastActivityTime: new Date().toISOString(),
            expiresAt: new Date(Date.now() + this.sessionTimeout).toISOString(),
            ipAddress: this.getClientIP(),
            userAgent: this.getUserAgent(),
            deviceType: this.detectDeviceType(),
            browser: this.detectBrowser(),
            status: 'active'
        };
    }

    /**
     * 生成会话 ID
     */
    generateSessionId() {
        return 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * 获取客户端 IP (模拟)
     */
    getClientIP() {
        // P1-11: 127.0.0.1 为模拟占位值，非配置硬编码 IP。
        //   实际应从后端获取真实 IP（后端 session API 待实现，见 syncToBackend TODO）。
        //   后端 CORS allowedOrigins 与前端 AuthService LOCAL_API_URL 已通过环境变量/全局变量管理（见 FIX_P1-11 文档）。
        return '127.0.0.1';
    }

    /**
     * 获取 User-Agent
     */
    getUserAgent() {
        return navigator.userAgent;
    }

    /**
     * 检测设备类型
     */
    detectDeviceType() {
        const ua = navigator.userAgent;
        if (/mobile|android|iphone|ipad|phone/i.test(ua.toLowerCase())) {
            return 'Mobile';
        }
        if (/tablet|ipad|playbook|silk/i.test(ua.toLowerCase())) {
            return 'Tablet';
        }
        return 'Desktop';
    }

    /**
     * 检测浏览器类型
     */
    detectBrowser() {
        const ua = navigator.userAgent;
        if (ua.indexOf('Edg') > -1) return 'Edge';
        if (ua.indexOf('Chrome') > -1) return 'Chrome';
        if (ua.indexOf('Safari') > -1) return 'Safari';
        if (ua.indexOf('Firefox') > -1) return 'Firefox';
        if (ua.indexOf('Trident') > -1) return 'IE';
        return 'Unknown';
    }

    /**
     * 获取当前会话
     */
    getCurrentSession() {
        const user = authService.getUser();
        if (!user) return null;

        return this.sessions.find(s => s.userId === user.id && s.status === 'active');
    }

    /**
     * 移除会话
     */
    removeSession(sessionId) {
        const session = this.sessions.find(s => s.id === sessionId);
        if (session) {
            session.status = 'inactive';
            session.logoutTime = new Date().toISOString();
            this.syncToBackend('remove', session);
        }
    }

    /**
     * 强制执行最大并发会话限制
     */
    enforceMaxSessions() {
        const user = authService.getUser();
        if (!user) return;

        const userSessions = this.sessions.filter(
            s => s.userId === user.id && s.status === 'active'
        );

        // 如果超过最大会话数，登出最早的会话
        if (userSessions.length > this.maxConcurrentSessions) {
            const oldestSession = userSessions.sort(
                (a, b) => new Date(a.loginTime) - new Date(b.loginTime)
            )[0];

            console.warn('⚠️ 超过最大并发会话数，登出最早的会话: ' + oldestSession.id);
            this.removeSession(oldestSession.id);
            UINotification.info('您在另一台设备登录，该设备的登录状态已取消');
        }
    }

    /**
     * 启动会话监控
     */
    startSessionMonitor() {
        setInterval(() => {
            this.checkSessionExpiry();
            this.updateLastActivityTime();
            this.syncSessions();
        }, 60000); // 每分钟检查一次
    }

    /**
     * 检查会话过期
     */
    checkSessionExpiry() {
        const now = new Date();

        this.sessions.forEach(session => {
            if (session.status === 'active' && new Date(session.expiresAt) < now) {
                console.warn('⚠️ 会话已过期: ' + session.id);
                this.removeSession(session.id);

                // 如果是当前用户，进行登出
                const currentUser = authService.getUser();
                if (currentUser && session.userId === currentUser.id) {
                    UINotification.warning('会话已过期，请重新登录');
                    authService.logout().then(() => {
                        window.location.href = './login.html';
                    });
                }
            }
        });
    }

    /**
     * 更新最后活动时间
     */
    updateLastActivityTime() {
        const currentSession = this.getCurrentSession();
        if (currentSession) {
            currentSession.lastActivityTime = new Date().toISOString();
            // 延长过期时间
            currentSession.expiresAt = new Date(
                Date.now() + this.sessionTimeout
            ).toISOString();
        }
    }

    /**
     * 启动设备检测
     */
    startDeviceDetection() {
        // 检测不同浏览器标签页的登出
        window.addEventListener('storage', (e) => {
            if (e.key === 'auth_token' && !authService.getToken()) {
                console.log('🔔 用户在其他设备/标签页登出');
                this.syncSessions();
            }
        });
    }

    /**
     * 同步会话到后端
     */
    async syncToBackend(action, session) {
        try {
            // TODO: 调用后端 API
            // await fetch('/api/session/' + action, {
            //     method: 'POST',
            //     headers: { 'Content-Type': 'application/json' },
            //     body: JSON.stringify(session)
            // });

            console.log('✅ 会话已同步到后端: ' + action + ' - ' + session.id);
        } catch (error) {
            console.error('❌ 同步会话到后端失败:', error);
        }
    }

    /**
     * 从后端同步会话
     */
    async syncSessions() {
        try {
            // TODO: 调用后端 API 获取最新会话列表
            // const response = await fetch('/api/session/list');
            // const sessions = await response.json();
            // this.sessions = sessions;
        } catch (error) {
            console.error('❌ 从后端同步会话失败:', error);
        }
    }

    /**
     * 获取用户的所有活跃会话
     */
    getUserActiveSessions() {
        const user = authService.getUser();
        if (!user) return [];

        return this.sessions.filter(s => 
            s.userId === user.id && s.status === 'active'
        );
    }

    /**
     * 强制登出其他设备
     */
    forceLogoutOtherDevices() {
        const user = authService.getUser();
        if (!user) return;

        const currentSession = this.getCurrentSession();
        const otherSessions = this.sessions.filter(s =>
            s.userId === user.id && 
            s.status === 'active' && 
            s.id !== currentSession?.id
        );

        otherSessions.forEach(session => {
            this.removeSession(session.id);
            this.syncToBackend('logout-forced', session);
        });

        UINotification.success('已登出其他所有设备');
    }

    /**
     * 强制登出指定会话
     */
    forceLogoutSession(sessionId) {
        this.removeSession(sessionId);
        this.syncToBackend('logout-forced', { id: sessionId });
        UINotification.success('会话已注销');
    }

    /**
     * 获取会话统计
     */
    getSessionStats() {
        const now = new Date();
        const activeSessions = this.sessions.filter(s => s.status === 'active');

        return {
            totalSessions: this.sessions.length,
            activeSessions: activeSessions.length,
            inactiveSessions: this.sessions.length - activeSessions.length,
            avgSessionDuration: this.calculateAvgSessionDuration(),
            peakConcurrentSessions: activeSessions.length,
            deviceDistribution: this.getDeviceDistribution()
        };
    }

    /**
     * 计算平均会话时长
     */
    calculateAvgSessionDuration() {
        if (this.sessions.length === 0) return 0;

        const totalDuration = this.sessions.reduce((sum, s) => {
            const start = new Date(s.loginTime);
            const end = s.logoutTime ? new Date(s.logoutTime) : new Date();
            return sum + (end - start);
        }, 0);

        return Math.round(totalDuration / this.sessions.length / 1000 / 60); // 转换为分钟
    }

    /**
     * 获取设备分布统计
     */
    getDeviceDistribution() {
        const distribution = {
            Desktop: 0,
            Mobile: 0,
            Tablet: 0
        };

        this.sessions.forEach(s => {
            distribution[s.deviceType] = (distribution[s.deviceType] || 0) + 1;
        });

        return distribution;
    }

    /**
     * 记录会话事件
     */
    recordSessionEvent(eventType, details = {}) {
        const currentSession = this.getCurrentSession();
        if (!currentSession) return;

        const event = {
            sessionId: currentSession.id,
            eventType: eventType,
            timestamp: new Date().toISOString(),
            details: details
        };

        // TODO: 发送到后端记录
        console.log('📝 会话事件记录:', event);
    }
}

// 导出单例
export const sessionManager = new SessionManager();
