/**
 * FeedbackModule - 问题反馈（意见反馈 / Bug 反馈 / 新需求建议）
 *
 * 面向全部登录身份（manager / operator / viewer / guest）：
 *   - 员工令牌（auth_token）与访客令牌（guest_token）均可提交；
 *   - 后端 POST /api/feedback 落 public.SystemLog 留档并推送钉钉群机器人；
 *   - 表单位于 index.html #feedback 区块，普通访客经 GuestDashboard 快速导航进入。
 */

import { authService } from '../services/AuthService.js';
import guestAuthService from '../services/GuestAuthService.js';

export function initFeedback() {
    const form = document.getElementById('feedbackForm');
    if (!form) return;

    const msgEl = document.getElementById('feedbackMsg');
    const submitBtn = document.getElementById('feedbackSubmitBtn');
    const contentEl = form.querySelector('textarea[name="content"]');
    const countEl = document.getElementById('feedbackContentCount');

    // 内容字数实时统计
    if (contentEl && countEl) {
        contentEl.addEventListener('input', () => {
            countEl.textContent = String(contentEl.value.length);
        });
    }

    function showMsg(text, kind) {
        if (!msgEl) return;
        const styles = {
            success: 'bg-green-50 border border-green-300 text-green-800',
            error: 'bg-red-50 border border-red-300 text-red-800',
        };
        msgEl.className = `p-3 rounded-md text-sm ${styles[kind] || styles.error}`;
        msgEl.textContent = text;
        msgEl.classList.remove('hidden');
        if (kind === 'success') {
            setTimeout(() => msgEl.classList.add('hidden'), 6000);
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // 员工令牌优先，访客令牌兜底（两者都是 Bearer 认证）
        const token = authService.getToken() || guestAuthService.getToken();
        if (!token) {
            showMsg('登录状态已失效，请重新登录后再提交。', 'error');
            return;
        }

        const fd = new FormData(form);
        const type = fd.get('type') || '';
        const content = (fd.get('content') || '').trim();
        const contact = (fd.get('contact') || '').trim();

        if (!content) {
            showMsg('请填写反馈内容。', 'error');
            contentEl?.focus();
            return;
        }

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>提交中...';
        }

        try {
            const resp = await fetch('/api/feedback', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ type, content, contact }),
            });
            const data = await resp.json().catch(() => ({}));

            if (resp.ok && data.success) {
                showMsg('✅ 反馈已提交成功！开发团队会尽快跟进处理，感谢您的支持。', 'success');
                form.reset();
                if (countEl) countEl.textContent = '0';
            } else {
                showMsg(data.error || `提交失败（HTTP ${resp.status}），请稍后重试。`, 'error');
            }
        } catch (err) {
            console.error('[feedback] 提交异常:', err);
            showMsg('网络异常，提交失败，请检查网络后重试。', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fas fa-paper-plane mr-2"></i>提交反馈';
            }
        }
    });
}
