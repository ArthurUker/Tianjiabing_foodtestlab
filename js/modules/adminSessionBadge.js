/**
 * admin-schools.html 顶部导航会话徽章 + idle 倒计时（从 module script 抽离，P-Refactor）。
 *
 * 职责：
 *   1. 渲染「当前登录用户」徽章（adminUserName）
 *   2. 启动「token 失效倒计时」徽章（adminIdleCountdown），30 分钟无活动自动登出
 *
 * 语义：与 SessionManager.sessionTimeout(30 分钟无活动自动登出) 同口径；
 *       任意用户操作（点击 / 键盘 / 滚动 / 触摸）均重置计时，归零后强制登出。
 * 安全：仅在 UI 提示当前会话状态，不引入新的计时存储；倒计时归零调用
 *       authService.logout() 走标准登出链路（清本地态 + 跳转登录页），避免与现有
 *       401 刷新拦截器 / SyncToBackend 心跳产生行为分叉。
 *
 * @param {object} opts
 * @param {object} opts.currentUser 服务端 verify-token 返回的用户对象（role/fullName/username）
 * @param {object} opts.authService  AuthService 单例（需含 logout()）
 */
export function initAdminSessionBadge({ currentUser, authService }) {
    // 渲染当前登录用户名徽章（防御性取值：后端不同分支可能返回不同字段）
    (function renderAdminHeaderBadges() {
        const nameEl = document.getElementById('adminUserName');
        if (nameEl) {
            const display = (currentUser && (currentUser.fullName || currentUser.username)) || '未知用户';
            nameEl.textContent = display;
            nameEl.title = display;
        }
    })();

    function startAdminIdleCountdown() {
        const IDLE_TIMEOUT_MS = 30 * 60 * 1000;     // 30 分钟无操作自动登出
        const WARN_THRESHOLD_MS = 5 * 60 * 1000;    // 剩余 ≤5 分钟切换告警态
        const TICK_INTERVAL_MS = 1000;              // UI 刷新粒度（1 秒）

        const badgeEl = document.getElementById('adminIdleBadge');
        const textEl  = document.getElementById('adminIdleCountdown');
        if (!badgeEl || !textEl) return;

        // 上次活动时间戳（页面级作用域内；刷新页面等价于会话重置，自然重置计时）
        let lastActivityAt = Date.now();
        let loggedOut = false;

        const resetActivity = () => {
            if (loggedOut) return;
            lastActivityAt = Date.now();
            // 用户刚刚操作了 → 立即清掉告警态，UI 体感即时反馈
            if (badgeEl.classList.contains('admin-idle-warn')) {
                badgeEl.classList.remove('admin-idle-warn');
            }
        };

        const formatRemaining = (ms) => {
            const total = Math.max(0, Math.floor(ms / 1000));
            const mm = Math.floor(total / 60);
            const ss = total % 60;
            return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
        };

        const doLogout = (reason) => {
            if (loggedOut) return;
            loggedOut = true;
            // 记录原因：登录页可读取并展示，避免用户感到「莫名其妙被踢」
            try { sessionStorage.setItem('admin_idle_logout_reason', reason || '1'); } catch (e) { /* 忽略 */ }
            // 走标准登出：清本地态（不影响后续标签页共用的 localStorage refresh token 时按其语义处理）
            authService.logout().finally(() => {
                window.location.replace('./super-admin-login.html');
            });
        };

        const tick = () => {
            if (loggedOut) return;
            const remaining = IDLE_TIMEOUT_MS - (Date.now() - lastActivityAt);
            if (remaining <= 0) {
                textEl.textContent = '00:00';
                doLogout('长时间无操作，会话已自动登出');
                return;
            }
            textEl.textContent = formatRemaining(remaining);
            if (remaining <= WARN_THRESHOLD_MS) {
                if (!badgeEl.classList.contains('admin-idle-warn')) {
                    badgeEl.classList.add('admin-idle-warn');
                }
            }
        };

        // 1) 用户活动事件：覆盖鼠标 / 键盘 / 滚动 / 触摸 / 点击。
        //    passive: true 提升滚动性能；capture: true 让事件尽早被处理，
        //    即便内层 stopPropagation 也会被记为一次活动（操作发生的事实优先于业务取消）。
        const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click', 'wheel'];
        ACTIVITY_EVENTS.forEach((evt) => {
            window.addEventListener(evt, resetActivity, { passive: true, capture: true });
        });

        // 2) 启动 UI 刷新：秒级粒度使用 setInterval 即可（无须 RAF），1 秒误差可接受。
        tick();
        const _intervalId = setInterval(tick, TICK_INTERVAL_MS);

        // 3) 页面隐藏（标签页后台 / 窗口最小化）时暂停秒级刷新以省电：
        //    恢复时立即走一次 tick 把显示补齐到当前剩余值（逻辑时长仍按真实流逝计算）。
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                tick();
                // 注意：不清 _intervalId——它在整个页面生命周期内保持运行即可。
            }
        });

        // 标记初始化完成，方便排查
        console.log('⏱️ 平台超管 idle 倒计时已启动（30 分钟无活动自动登出）');
        // 便于调试 / 单元测试：暴露只读访问器（无副作用）
        window.__adminIdleTimer = {
            get remainingMs() { return Math.max(0, IDLE_TIMEOUT_MS - (Date.now() - lastActivityAt)); },
            get lastActivityAt() { return lastActivityAt; },
            _intervalId
        };
    }
    startAdminIdleCountdown();
}
