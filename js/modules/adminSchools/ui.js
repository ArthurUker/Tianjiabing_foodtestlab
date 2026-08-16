// ====== adminSchools 共享 UI 工具 ======

export function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 顶部通知条（#notice）：展示后 5 秒自动隐藏（行为与原内联 showNotice 一致）
let noticeTimer = null;
export function showNotice(msg, type = 'info') {
    const notice = document.getElementById('notice');
    if (!notice) return;
    notice.textContent = msg;
    notice.className = 'mb-4 p-3 rounded-lg text-sm ' + (
        type === 'error' ? 'bg-red-100 border border-red-400 text-red-700'
        : type === 'success' ? 'bg-green-100 border border-green-400 text-green-700'
        : 'bg-blue-100 border border-blue-400 text-blue-700'
    );
    notice.classList.remove('hidden');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.classList.add('hidden'), 5000);
}
