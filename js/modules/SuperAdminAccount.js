import { authService, getApiBaseUrl } from '../services/AuthService.js'

function escapeHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function formatDate(s) {
    if (!s) return '-'
    const d = new Date(s)
    if (isNaN(d.getTime())) return '-'
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function initSuperAdminAccount({ notify }) {
    const apiBase = getApiBaseUrl()
    const token = () => authService.getToken()

    const modal = document.getElementById('saAccountModal')
    const openBtn = document.getElementById('btnAccountMgmt')
    const closeBtn = document.getElementById('saAccountClose')
    const listEl = document.getElementById('saAdminList')
    const changeForm = document.getElementById('saChangePwdForm')
    const addForm = document.getElementById('saAddAdminForm')
    const addWrap = document.getElementById('saAddAdminFormWrap')
    const showAddBtn = document.getElementById('saShowAddBtn')
    const cancelAddBtn = document.getElementById('saCancelAddBtn')

    function headers() {
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }
    }

    async function loadSuperAdmins() {
        if (!listEl) return
        try {
            const res = await fetch(`${apiBase}/api/user/super-admin`, { headers: headers() })
            const data = await res.json()
            if (!res.ok) { notify?.(data.error || '加载超管列表失败', 'error'); return }
            const admins = data.admins || []
            if (!admins.length) {
                listEl.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-gray-400 text-sm">暂无超管账号</td></tr>'
                return
            }
            listEl.innerHTML = admins.map((a) => `
                <tr class="border-t border-gray-100">
                    <td class="px-4 py-3 text-sm">${escapeHtml(a.username)}</td>
                    <td class="px-4 py-3 text-sm">${escapeHtml(a.full_name || '-')}</td>
                    <td class="px-4 py-3 text-sm">${a.must_change_password ? '<span class="text-orange-500 text-xs">需改密</span>' : '<span class="text-green-600 text-xs">正常</span>'}</td>
                    <td class="px-4 py-3 text-sm text-gray-500">${formatDate(a.created_at)}</td>
                    <td class="px-4 py-3 text-sm text-right">
                        <button type="button" class="sa-del-btn text-red-500 hover:text-red-700 text-xs" data-id="${a.id}" data-username="${escapeHtml(a.username)}">删除</button>
                    </td>
                </tr>`).join('')
        } catch (e) {
            notify?.(e.message || '加载失败', 'error')
        }
    }

    openBtn?.addEventListener('click', () => {
        modal?.classList.remove('hidden')
        loadSuperAdmins()
    })
    closeBtn?.addEventListener('click', () => modal?.classList.add('hidden'))
    modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden') })
    showAddBtn?.addEventListener('click', () => addWrap?.classList.remove('hidden'))
    cancelAddBtn?.addEventListener('click', () => addWrap?.classList.add('hidden'))

    changeForm?.addEventListener('submit', async (e) => {
        e.preventDefault()
        const oldP = changeForm.sa_oldPassword.value
        const newP = changeForm.sa_newPassword.value
        const confirm = changeForm.sa_confirmPassword.value
        if (!oldP || !newP) { notify?.('请填写当前密码与新密码', 'error'); return }
        if (newP !== confirm) { notify?.('两次输入的新密码不一致', 'error'); return }
        try {
            const res = await fetch(`${apiBase}/api/user/change-password`, {
                method: 'POST', headers: headers(),
                body: JSON.stringify({ oldPassword: oldP, newPassword: newP })
            })
            const data = await res.json()
            if (!res.ok) { notify?.(data.error || '修改失败', 'error'); return }
            notify?.('密码修改成功', 'success')
            changeForm.reset()
        } catch (err) { notify?.(err.message || '修改失败', 'error') }
    })

    addForm?.addEventListener('submit', async (e) => {
        e.preventDefault()
        const username = addForm.sa_username.value.trim()
        const fullName = addForm.sa_fullName.value.trim()
        const email = addForm.sa_email.value.trim()
        const password = addForm.sa_password.value
        if (!username || !fullName || !password) { notify?.('请填写用户名、姓名和密码', 'error'); return }
        try {
            const res = await fetch(`${apiBase}/api/user/super-admin`, {
                method: 'POST', headers: headers(),
                body: JSON.stringify({ username, fullName, email, password })
            })
            const data = await res.json()
            if (!res.ok) { notify?.(data.error || '创建失败', 'error'); return }
            notify?.('超管账号创建成功', 'success')
            addForm.reset()
            addWrap?.classList.add('hidden')
            loadSuperAdmins()
        } catch (err) { notify?.(err.message || '创建失败', 'error') }
    })

    listEl?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.sa-del-btn')
        if (!btn) return
        const id = btn.dataset.id
        const uname = btn.dataset.username
        if (!confirm(`确定删除平台超管账号「${uname}」吗？此操作不可恢复。`)) return
        try {
            const res = await fetch(`${apiBase}/api/user/super-admin/${id}`, {
                method: 'DELETE', headers: headers()
            })
            const data = await res.json()
            if (!res.ok) { notify?.(data.error || '删除失败', 'error'); return }
            notify?.('已删除', 'success')
            loadSuperAdmins()
        } catch (err) { notify?.(err.message || '删除失败', 'error') }
    })

    console.log('✅ 平台超管账号管理已初始化')
}
