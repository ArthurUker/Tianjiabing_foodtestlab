// ====== 用户管理（机械迁移自 admin-schools.html 3783-4031，仅做依赖注入，无行为变化）======
// 含：用户列表、重置密码、启用/停用、新增/编辑用户（401/403 差异化提示）、重新初始化学校。
import { state } from '../customization/store.js';
import { escapeHtml, showNotice } from '../ui.js';
import { adminFetch } from '../context.js';

let currentUsers = [];

export async function loadUsers() {
    if (!state.currentSchoolCode) return;
    const tbody = document.getElementById('usersTbody');
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-gray-400">加载中...</td></tr>';
    try {
        const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/users`);
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '加载失败');
        const users = json.data || [];
        currentUsers = users;
        if (!users.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-gray-400">暂无用户</td></tr>';
            return;
        }
        const roleMap = { admin: '平台管理员', manager: '主管', operator: '操作人员', viewer: '查看者', user: '普通用户' };
        tbody.innerHTML = users.map(u => `
            <tr>
                <td class="font-mono">${escapeHtml(u.username)}</td>
                <td>${escapeHtml(u.full_name || '-')}</td>
                <td>${roleMap[u.role] || u.role}</td>
                <td>${(u.status || 'active') === 'active' ? '<span class="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">启用</span>' : '<span class="px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs">停用</span>'}</td>
                <td class="text-xs text-gray-500">${u.created_at ? new Date(u.created_at).toLocaleDateString() : ''}</td>
                <td class="text-xs text-gray-500">${u.last_login ? new Date(u.last_login).toLocaleDateString() : '—'}</td>
                <td class="space-x-1 whitespace-nowrap">
                    <button class="px-2 py-1 text-xs bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100 transition btn-edit-user" data-id="${escapeHtml(u.id)}"><i class="fas fa-edit mr-1"></i>编辑</button>
                    <button class="px-2 py-1 text-xs bg-orange-50 text-orange-700 rounded hover:bg-orange-100 transition btn-reset-pwd" data-id="${escapeHtml(u.id)}" data-username="${escapeHtml(u.username)}"><i class="fas fa-key mr-1"></i>重置密码</button>
                    ${(u.status || 'active') === 'active'
                        ? `<button class="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition btn-toggle-user" data-id="${escapeHtml(u.id)}" data-active="false"><i class="fas fa-ban mr-1"></i>停用</button>`
                        : `<button class="px-2 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100 transition btn-toggle-user" data-id="${escapeHtml(u.id)}" data-active="true"><i class="fas fa-check mr-1"></i>启用</button>`
                    }
                    <button class="px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100 transition btn-delete-user" data-id="${escapeHtml(u.id)}" data-username="${escapeHtml(u.username)}"><i class="fas fa-trash mr-1"></i>删除</button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.btn-reset-pwd').forEach(btn => {
            btn.addEventListener('click', () => openResetPwd(btn.dataset.id, btn.dataset.username));
        });
        tbody.querySelectorAll('.btn-toggle-user').forEach(btn => {
            btn.addEventListener('click', () => toggleUser(btn.dataset.id, btn.dataset.active === 'true'));
        });
        tbody.querySelectorAll('.btn-edit-user').forEach(btn => {
            btn.addEventListener('click', () => {
                const u = currentUsers.find(x => x.id === btn.dataset.id);
                if (u) openUserModal(u);
            });
        });
        tbody.querySelectorAll('.btn-delete-user').forEach(btn => {
            btn.addEventListener('click', () => deleteUser(btn.dataset.id, btn.dataset.username));
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-red-500">${escapeHtml(e.message)}</td></tr>`;
    }
}

// 重置密码
function openResetPwd(userId, username) {
    document.getElementById('rp_userId').value = userId;
    document.getElementById('rp_username').textContent = username;
    document.getElementById('rp_newPassword').value = '';
    document.getElementById('resetPwdModal').classList.remove('hidden');
    document.getElementById('resetPwdModal').classList.add('flex');
}

document.getElementById('cancelResetPwd').addEventListener('click', () => {
    document.getElementById('resetPwdModal').classList.add('hidden');
    document.getElementById('resetPwdModal').classList.remove('flex');
});

document.getElementById('resetPwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = document.getElementById('rp_userId').value;
    const newPassword = document.getElementById('rp_newPassword').value;
    try {
        const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/users/${userId}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ newPassword })
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '重置失败');
        showNotice('✅ 密码已重置', 'success');
        document.getElementById('resetPwdModal').classList.add('hidden');
        document.getElementById('resetPwdModal').classList.remove('flex');
        loadUsers();   // P5: 重置后刷新用户列表,避免需手动刷新才生效
    } catch (e) {
        showNotice('❌ ' + e.message, 'error');
    }
});

// 启用/停用用户
async function toggleUser(userId, isActive) {
    try {
        const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/users/${userId}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: isActive ? 'active' : 'disabled' })
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '操作失败');
        showNotice(`✅ 用户已${isActive ? '启用' : '停用'}`, 'success');
        loadUsers();
    } catch (e) {
        showNotice('❌ ' + e.message, 'error');
    }
}

// ====== 用户新增 / 编辑 ======
document.getElementById('btnAddUser').addEventListener('click', () => openUserModal(null));
document.getElementById('userModalClose').addEventListener('click', closeUserModal);
document.getElementById('userCancelUser').addEventListener('click', closeUserModal);

// 重新初始化学校（补全 schema / 表结构 / 首个 manager）
document.getElementById('btnReprovision').addEventListener('click', async () => {
    if (!state.currentSchoolCode) return;
    if (!confirm(`确定重新初始化学校「${state.currentSchoolCode}」吗？\n将补全数据库表结构与默认管理员账号，已存在的数据不会丢失。`)) return;
    try {
        const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/reprovision`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '初始化失败');
        showNotice('✅ ' + (json.message || '已重新初始化'), 'success');
        loadUsers();
    } catch (e) {
        showNotice('❌ ' + e.message, 'error');
    }
});

function openUserModal(user) {
    const isEdit = !!user;
    document.getElementById('userEditId').value = isEdit ? user.id : '';
    document.getElementById('userModalTitle').innerHTML = isEdit
        ? '<i class="fas fa-user-edit mr-2 text-indigo-600"></i>编辑用户'
        : '<i class="fas fa-user-plus mr-2 text-indigo-600"></i>新增用户';
    document.getElementById('userUsername').value = isEdit ? user.username : '';
    document.getElementById('userUsername').disabled = isEdit;
    document.getElementById('userFullname').value = isEdit ? (user.full_name || '') : '';
    document.getElementById('userPhone').value = isEdit ? (user.phone || '') : '';
    document.getElementById('userRole').value = (isEdit && user.role) ? user.role : 'manager';
    document.getElementById('userPassword').value = '';
    // 创建时显示初始密码；编辑时显示状态开关
    document.getElementById('userPwdWrap').classList.toggle('hidden', isEdit);
    const statusWrap = document.getElementById('userStatusWrap');
    if (isEdit) {
        statusWrap.classList.remove('hidden');
        statusWrap.classList.add('flex');
        document.getElementById('userActive').checked = ((user.status || 'active') === 'active');
    } else {
        statusWrap.classList.add('hidden');
        statusWrap.classList.remove('flex');
    }
    document.getElementById('userFormError').classList.add('hidden');
    const m = document.getElementById('userModal');
    m.classList.remove('hidden');
    m.classList.add('flex');
    if (!isEdit) document.getElementById('userUsername').focus();
}

function closeUserModal() {
    const m = document.getElementById('userModal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('userFormError');
    errEl.classList.add('hidden');
    const id = document.getElementById('userEditId').value;
    const isEdit = !!id;
    const payload = {
        full_name: document.getElementById('userFullname').value.trim(),
        phone: document.getElementById('userPhone').value.trim(),
        role: document.getElementById('userRole').value
    };
    const pwd = document.getElementById('userPassword').value;
    if (!isEdit) {
        payload.username = document.getElementById('userUsername').value.trim();
        payload.password = pwd;
        payload.status = 'active';
        if (!payload.username || !/^[a-zA-Z0-9_]{3,32}$/.test(payload.username)) {
            errEl.textContent = '用户名需为 3-32 位字母、数字或下划线'; errEl.classList.remove('hidden'); return;
        }
        if (!pwd || pwd.length < 8) {
            errEl.textContent = '初始密码至少 8 位'; errEl.classList.remove('hidden'); return;
        }
    } else {
        payload.status = document.getElementById('userActive').checked ? 'active' : 'disabled';
        if (pwd) {
            if (pwd.length < 8) { errEl.textContent = '密码至少 8 位'; errEl.classList.remove('hidden'); return; }
            payload.password = pwd;
        }
    }
    try {
        const url = isEdit
            ? `/api/admin/schools/${state.currentSchoolCode}/users/${id}`
            : `/api/admin/schools/${state.currentSchoolCode}/users`;
        const resp = await adminFetch(url, {
            method: isEdit ? 'PUT' : 'POST',
            body: JSON.stringify(payload)
        });
        const json = await resp.json();
        if (!resp.ok) {
            const err = new Error(json.error || '保存失败');
            err.status = resp.status;
            throw err;
        }
        closeUserModal();
        showNotice('✅ ' + (json.message || '已保存'), 'success');
        loadUsers();
    } catch (err) {
        // FIX-14: 区分 401（登录失效）/403（无权限）/其它，给出可操作提示
        if (err.status === 401) {
            errEl.textContent = '登录状态已失效，请重新以平台超管登录';
            errEl.classList.remove('hidden');
            setTimeout(() => { window.location.href = '/super-admin-login.html'; }, 1200);
            return;
        }
        if (err.status === 403) {
            errEl.textContent = '当前账号无权限管理该校用户（仅平台超管可操作）';
            errEl.classList.remove('hidden');
            return;
        }
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
    }
});

async function deleteUser(id, username) {
    if (!confirm(`确定删除用户「${username}」吗？此操作不可恢复。`)) return;
    try {
        const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/users/${id}`, {
            method: 'DELETE'
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '删除失败');
        showNotice('✅ ' + (json.message || '已删除'), 'success');
        loadUsers();
    } catch (e) {
        showNotice('❌ ' + e.message, 'error');
    }
}
