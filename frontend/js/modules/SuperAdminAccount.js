import { authService, getApiBaseUrl } from '../services/AuthService.js'
import { escapeHtml } from '../utils/schoolCustomization/shared.js'

function formatDate(s) {
    if (!s) return '-'
    const d = new Date(s)
    if (isNaN(d.getTime())) return '-'
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function isStrongPassword(password) {
    if (!password) return false
    return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password)
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
    const resetPwdWrap = document.getElementById('saResetPwdWrap')
    const resetPwdForm = document.getElementById('saResetPwdForm')
    const resetPwdIdEl = document.getElementById('saResetPwdId')
    const resetPwdUsernameEl = document.getElementById('saResetPwdUsername')
    const cancelResetPwdBtn = document.getElementById('saCancelResetPwd')

    // 编辑现有超管（admin-schools.html 行内「编辑」按钮触发 / 外部 preFill 调用）
    const editWrap = document.getElementById('saEditAdminFormWrap')
    const editForm = document.getElementById('saEditAdminForm')
    const editIdEl = document.getElementById('saEditAdminId')
    const editUsernameLabelEl = document.getElementById('saEditAdminUsername')
    const editUsernameInputEl = document.getElementById('saEditAdminUsernameInput')
    const editFullNameEl = document.getElementById('saEditAdminFullName')
    const editEmailEl = document.getElementById('saEditAdminEmail')
    const editErrorEl = document.getElementById('saEditAdminError')
    const cancelEditBtn = document.getElementById('saCancelEditAdmin')

    function headers() {
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }
    }

    function closeAddForm() {
        addWrap?.classList.add('hidden')
        addForm?.reset()
    }

    function closeResetPwdForm() {
        resetPwdWrap?.classList.add('hidden')
        resetPwdForm?.reset()
        if (resetPwdIdEl) resetPwdIdEl.value = ''
        if (resetPwdUsernameEl) resetPwdUsernameEl.textContent = ''
    }

    function closeEditForm() {
        editWrap?.classList.add('hidden')
        editForm?.reset()
        if (editIdEl) editIdEl.value = ''
        if (editUsernameLabelEl) editUsernameLabelEl.textContent = ''
        if (editUsernameInputEl) editUsernameInputEl.value = ''
        if (editFullNameEl) editFullNameEl.value = ''
        if (editEmailEl) editEmailEl.value = ''
        editErrorEl?.classList.add('hidden')
        if (editErrorEl) editErrorEl.textContent = ''
    }

    /**
     * 预填并显示"编辑现有超管"表单。
     * 外部（accountsView 行内「编辑」按钮）传入完整或部分 admin 对象即可：
     *   { id, username, full_name, email }
     * 若字段缺失，username 将以 id 兜底显示，姓名/邮箱保持空。
     */
    function openEditAdminForm(admin) {
        if (!admin || !admin.id) {
            notify?.('无法打开编辑表单：缺少账号 ID', 'error')
            return
        }
        // 关闭同区域内其它可能展开的子表单，保证互斥
        closeAddForm()
        closeResetPwdForm()
        if (editIdEl) editIdEl.value = admin.id
        const uname = admin.username || `(id=${admin.id})`
        if (editUsernameLabelEl) editUsernameLabelEl.textContent = uname
        if (editUsernameInputEl) editUsernameInputEl.value = uname
        if (editFullNameEl) editFullNameEl.value = (admin.full_name || admin.fullName || '')
        if (editEmailEl) editEmailEl.value = (admin.email || '')
        editErrorEl?.classList.add('hidden')
        if (editErrorEl) editErrorEl.textContent = ''
        // 同时显示弹层（外部触发时弹层可能尚未打开）
        if (modal) modal.classList.remove('hidden')
        editWrap?.classList.remove('hidden')
        editWrap?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }

    // 暴露到 window，供 accountsView 行内「编辑」按钮调用（预填并打开编辑表单）
    window.superAdminOpenEditForm = openEditAdminForm

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
                        <button type="button" class="sa-reset-btn text-orange-500 hover:text-orange-700 text-xs mr-2" data-id="${a.id}" data-username="${escapeHtml(a.username)}">重置密码</button>
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
    showAddBtn?.addEventListener('click', () => {
        closeResetPwdForm()
        addWrap?.classList.remove('hidden')
    })
    cancelAddBtn?.addEventListener('click', closeAddForm)
    cancelResetPwdBtn?.addEventListener('click', closeResetPwdForm)
    cancelEditBtn?.addEventListener('click', closeEditForm)

    changeForm?.addEventListener('submit', async (e) => {
        e.preventDefault()
        const oldP = changeForm.sa_oldPassword.value
        const newP = changeForm.sa_newPassword.value
        const confirm = changeForm.sa_confirmPassword.value
        if (!oldP || !newP) { notify?.('请填写当前密码与新密码', 'error'); return }
        if (!isStrongPassword(newP)) { notify?.('新密码至少8个字符，且必须包含字母和数字', 'error'); return }
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
        if (!isStrongPassword(password)) { notify?.('密码至少8个字符，且必须包含字母和数字', 'error'); return }
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

    resetPwdForm?.addEventListener('submit', async (e) => {
        e.preventDefault()
        const id = resetPwdIdEl?.value
        const username = resetPwdUsernameEl?.textContent || ''
        const newP = resetPwdForm.saResetPwdNew.value
        const confirm = resetPwdForm.saResetPwdConfirm.value
        if (!id) { notify?.('未选择要重置的账号', 'error'); return }
        if (!isStrongPassword(newP)) { notify?.('新密码至少8个字符，且必须包含字母和数字', 'error'); return }
        if (newP !== confirm) { notify?.('两次输入的新密码不一致', 'error'); return }
        try {
            const res = await fetch(`${apiBase}/api/user/super-admin/${encodeURIComponent(id)}/reset-password`, {
                method: 'POST', headers: headers(),
                body: JSON.stringify({ newPassword: newP })
            })
            const data = await res.json()
            if (!res.ok) { notify?.(data.error || '重置失败', 'error'); return }
            notify?.(`账号「${username}」密码已重置`, 'success')
            closeResetPwdForm()
            loadSuperAdmins()
        } catch (err) { notify?.(err.message || '重置失败', 'error') }
    })

    editForm?.addEventListener('submit', async (e) => {
        e.preventDefault()
        const id = editIdEl?.value
        if (!id) { notify?.('未选择要编辑的账号', 'error'); return }
        const fullName = editFullNameEl?.value.trim() || ''
        const email = editEmailEl?.value.trim() || ''
        if (!fullName) {
            editErrorEl.textContent = '姓名不能为空'
            editErrorEl.classList.remove('hidden')
            return
        }
        try {
            const payload = { fullName, email }
            const res = await fetch(`${apiBase}/api/user/super-admin/${encodeURIComponent(id)}`, {
                method: 'PUT', headers: headers(),
                body: JSON.stringify(payload)
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                const msg = (data && data.error) || '编辑失败'
                editErrorEl.textContent = msg
                editErrorEl.classList.remove('hidden')
                return
            }
            notify?.(`账号「${editUsernameInputEl?.value || id}」已更新`, 'success')
            closeEditForm()
            loadSuperAdmins()
            // 行内列表（如已打开）刷新由外部调用方（accountsView）处理
            if (typeof window.superAdminInlineRefresh === 'function') {
                try { window.superAdminInlineRefresh() } catch (_) { /* 静默 */ }
            }
        } catch (err) {
            editErrorEl.textContent = err.message || '编辑失败'
            editErrorEl.classList.remove('hidden')
        }
    })

    listEl?.addEventListener('click', async (e) => {
        const resetBtn = e.target.closest('.sa-reset-btn')
        if (resetBtn) {
            const id = resetBtn.dataset.id
            const uname = resetBtn.dataset.username
            if (!id || !resetPwdWrap || !resetPwdIdEl || !resetPwdUsernameEl) return
            closeAddForm()
            resetPwdIdEl.value = id
            resetPwdUsernameEl.textContent = uname
            resetPwdWrap.classList.remove('hidden')
            resetPwdWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
            return
        }

        const btn = e.target.closest('.sa-del-btn')
        if (!btn) return
        const id = btn.dataset.id
        const uname = btn.dataset.username
        // P1-2: 原生 confirm → UINotification.confirm（iframe 预览下可用）
        const confirmed = await UINotification.confirm(`确定删除平台超管账号「${uname}」吗？此操作不可恢复。`, '删除确认')
        if (!confirmed) return
        try {
            const res = await fetch(`${apiBase}/api/user/super-admin/${encodeURIComponent(id)}`, {
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
