/**
 * FeedbackModule - 问题反馈（意见反馈 / Bug 反馈 / 新需求建议）
 *
 * 面向全部登录身份（manager / operator / viewer / guest）：
 *   - 员工令牌（auth_token）与访客令牌（guest_token）均可提交；
 *   - 支持附加截图（≤3 张、单张 ≤5MB，base64 随 JSON 提交，后端落盘并内嵌钉钉消息）；
 *   - 表单位于 index.html #feedback 区块，普通访客经 GuestDashboard 快速导航进入。
 */

import { authService } from '../services/AuthService.js';
import guestAuthService from '../services/GuestAuthService.js';

// 截图限制（与后端 feedbackRoutes.js 保持一致）
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 3;

export function initFeedback() {
    const form = document.getElementById('feedbackForm');
    if (!form) return;

    const msgEl = document.getElementById('feedbackMsg');
    const submitBtn = document.getElementById('feedbackSubmitBtn');
    const contentEl = form.querySelector('textarea[name="content"]');
    const countEl = document.getElementById('feedbackContentCount');
    const imageInput = document.getElementById('feedbackImageInput');
    const imageListEl = document.getElementById('feedbackImageList');

    // 已选截图：{ name, dataURL }
    const images = [];

    // ── 内容字数实时统计 ──
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

    // ── 截图选择 / 预览 / 删除 ──
    function escapeAttr(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderImages() {
        if (!imageListEl) return;
        imageListEl.innerHTML = images.map((img, i) => `
            <div class="relative group">
                <img src="${img.dataURL}" alt="${escapeAttr(img.name)}"
                    class="w-20 h-20 object-cover rounded-md border border-gray-300">
                <button type="button" data-fb-img-idx="${i}" title="移除"
                    class="absolute -top-2 -right-2 w-5 h-5 bg-red-600 text-white rounded-full text-xs leading-none shadow hover:bg-red-700 transition">&times;</button>
            </div>
        `).join('');
    }

    function readAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('读取失败'));
            reader.readAsDataURL(file);
        });
    }

    if (imageInput) {
        imageInput.addEventListener('change', async () => {
            const files = Array.from(imageInput.files || []);
            imageInput.value = ''; // 允许重复选择同一文件
            for (const file of files) {
                if (images.length >= MAX_IMAGES) {
                    showMsg(`截图最多 ${MAX_IMAGES} 张。`, 'error');
                    break;
                }
                if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
                    showMsg(`「${file.name}」不是支持的图片格式（png / jpg / webp / gif）。`, 'error');
                    continue;
                }
                if (file.size > MAX_IMAGE_BYTES) {
                    showMsg(`「${file.name}」超过 5MB，请压缩后再添加。`, 'error');
                    continue;
                }
                try {
                    const dataURL = await readAsDataURL(file);
                    images.push({ name: file.name, dataURL });
                } catch (e) {
                    showMsg(`「${file.name}」读取失败，请重试。`, 'error');
                }
            }
            renderImages();
        });
    }

    if (imageListEl) {
        imageListEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-fb-img-idx]');
            if (!btn) return;
            const idx = Number(btn.dataset.fbImgIdx);
            if (idx >= 0 && idx < images.length) {
                images.splice(idx, 1);
                renderImages();
            }
        });
    }

    // ── 提交 ──
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
                body: JSON.stringify({
                    type,
                    content,
                    contact,
                    images: images.map((img) => img.dataURL),
                }),
            });
            const data = await resp.json().catch(() => ({}));

            if (resp.ok && data.success) {
                const n = Array.isArray(data.images) ? data.images.length : 0;
                showMsg(`✅ 反馈已提交成功！开发团队会尽快跟进处理，感谢您的支持。`, 'success');
                form.reset();
                if (countEl) countEl.textContent = '0';
                images.length = 0;
                renderImages();
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
