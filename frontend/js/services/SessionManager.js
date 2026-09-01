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
        //   - syncToBackend / syncSessions 已对接后端 /api/session（登录/登出/强制登出同步落库，TD-Session ✅）
        //   - 遗留：inactive 会话不从数组移除（removeSession 仅改 status），长期运行可能内存增长 → TD-P2-15 评估
        //   - getClientIP() 返回模拟 127.0.0.1（见下方注释），非配置硬编码
        this.sessions = [];
        this.maxConcurrentSessions = 5; // 最多允许同时活跃会话数
        this.sessionTimeout = 30 * 60 * 1000; // 30 分钟无活动自动登出
        this._abortCtrl = null;          // TD-EventLeak-Phase2: 用于取消事件监听
        this._monitorInterval = null;    // TD-NoBeforeUnload: 保存监控定时器句柄
    }

    /**
     * 初始化会话管理器
     */
    init() {
        // TD-EventLeak-Phase2: 重新初始化时先取消上一次注册的监听，避免监听器累加
        this._abortCtrl?.abort();
        this._abortCtrl = new AbortController();

        console.log('🔧 ' + this.moduleName + ' 初始化中...');

        // 启动会话定期检查
        this.startSessionMonitor();

        // 启动设备检测
        this.startDeviceDetection();

        // 监听登录事件（携带 signal，重初始化时自动移除）
        window.addEventListener('userLogin', () => this.onUserLogin(), { signal: this._abortCtrl.signal });

        // 监听登出事件（携带 signal，重初始化时自动移除）
        window.addEventListener('userLogout', () => this.onUserLogout(), { signal: this._abortCtrl.signal });

        // TD-NoBeforeUnload: 页面隐藏时暂停监控，恢复可见时重启监控
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.stopSessionMonitor();
            } else {
                this.startSessionMonitor();
            }
        }, { signal: this._abortCtrl.signal });

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
     * 获取客户端 IP（前端侧尽力值）
     * 说明：浏览器无法可靠获取自身公网 IP，这里返回本地回环占位；
     * 真实的客户端 IP 由后端在会话落库时从请求连接（req.ip）捕获，
     * 故该字段仅作前端标记，安全口径以后端为准。
     */
    getClientIP() {
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
        // 若已有定时器先清除，避免重复累加（TD-NoBeforeUnload/重入保护）
        if (this._monitorInterval) clearInterval(this._monitorInterval);
        this._monitorInterval = setInterval(() => {
            this.checkSessionExpiry();
            this.updateLastActivityTime();
            this.syncSessions();
            // 心跳：每分钟用当前会话 POST /api/session（upsert 刷新 last_seen_at），
            // 使后端会话表的「最后活跃时间」与前端一致（TD-Session 收口）。
            const current = this.getCurrentSession();
            if (current) this.syncToBackend('heartbeat', current);
        }, 60000); // 每分钟检查一次
    }

    /**
     * 暂停会话监控（TD-NoBeforeUnload: 页面隐藏时调用）
     */
    stopSessionMonitor() {
        if (this._monitorInterval) {
            clearInterval(this._monitorInterval);
            this._monitorInterval = null;
        }
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
                    }).catch(() => {
                        window.location.href = './login.html'; // NB-26: reject 时也跳转
                    });
                }
            }
        });

        // TD-P2-15: 清理登出超过 10 分钟的 inactive/revoked 会话，避免内存无限增长
        const _cutoff = new Date(Date.now() - 10 * 60 * 1000);
        this.sessions = this.sessions.filter(s => {
            if (s.status === 'active') return true;
            const _t = s.logoutTime ? new Date(s.logoutTime) : null;
            return !_t || _t > _cutoff;
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
        }, { signal: this._abortCtrl.signal });
    }

    /**
     * 同步会话到后端（TD-Session 收口）
     * - action='add'             → POST   /api/session（注册/心跳）
     * - action='remove'          → DELETE /api/session/:id（登出）
     * - action='logout-forced'   → DELETE /api/session/:id（强制登出其它设备）
     */
    async syncToBackend(action, session) {
        try {
            const token = authService.getToken()
            if (!token) return

            const headers = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            }

            let method = 'POST'
            let url = '/api/session'
            let body
            if (action === 'remove' || action === 'logout-forced') {
                method = 'DELETE'
                url = `/api/session/${session.id}`
            } else {
                body = JSON.stringify({
                    sessionId: session.id,
                    deviceType: session.deviceType,
                    browser: session.browser,
                    userAgent: session.userAgent,
                })
            }

            const resp = await fetch(url, { method, headers, body })
            if (!resp.ok) {
                console.warn(`⚠️ 会话同步到后端失败: ${action} -> HTTP ${resp.status}`)
            }
        } catch (error) {
            console.error('❌ 同步会话到后端失败:', error)
        }
    }

    /**
     * 从后端同步会话（TD-Session 收口）
     * 拉取当前用户的活跃会话列表，将后端已撤销（revoked）的会话在本地同步标记为非活跃。
     */
    async syncSessions() {
        try {
            const token = authService.getToken()
            if (!token) return

            const resp = await fetch('/api/session', {
                headers: { Authorization: `Bearer ${token}` },
            })
            if (!resp.ok) return

            const json = await resp.json()
            const remote = new Set((json.data || []).map((s) => s.id))
            this.sessions.forEach((s) => {
                if (s.status === 'active' && !remote.has(s.id)) {
                    s.status = 'revoked'
                }
            })
        } catch (error) {
            console.error('❌ 从后端同步会话失败:', error)
        }
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
}

// 导出单例
export const sessionManager = new SessionManager();
