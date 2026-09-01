// ====== 新增学校（机械迁移自 admin-schools.html 4033-4098，仅做依赖注入，无行为变化）======
import { showNotice } from '../ui.js';
import { adminFetch } from '../context.js';
import { schoolLoginUrl, loadSchools } from './schoolsListView.js';

document.getElementById('btnShowCreate').addEventListener('click', () => {
    document.getElementById('createForm').reset();
    document.getElementById('cf_themeColor').value = '#1a73e8';
    document.getElementById('createModal').classList.remove('hidden');
    document.getElementById('createModal').classList.add('flex');
});

document.getElementById('closeCreateModal').addEventListener('click', closeCreateModal);
document.getElementById('cancelCreate').addEventListener('click', closeCreateModal);

function closeCreateModal() {
    document.getElementById('createModal').classList.add('hidden');
    document.getElementById('createModal').classList.remove('flex');
}

document.getElementById('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('cf_code').value.trim();
    const name = document.getElementById('cf_name').value.trim();
    const shortName = document.getElementById('cf_shortName').value.trim();
    const themeColor = document.getElementById('cf_themeColor').value.trim();
    const logoUrl = document.getElementById('cf_logoUrl').value.trim();
    const adminUsername = document.getElementById('cf_adminUsername').value.trim();
    const adminPassword = document.getElementById('cf_adminPassword').value;

    const btn = document.getElementById('createBtn');
    const btnText = document.getElementById('createBtnText');
    btn.disabled = true;
    btnText.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>创建中...';

    try {
        const resp = await adminFetch('/api/admin/schools', {
            method: 'POST',
            body: JSON.stringify({ code, name, adminUsername, adminPassword })
        });
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || json.details || '创建失败');

        // 创建成功后如果有外观信息，更新它
        // P0-2: 二次 PUT 也需检查 resp.ok，失败时抛出并 toast（与编辑表单反馈一致），
        //       避免「学校已创建但外观未保存」被静默吞掉、无任何提示。
        if (shortName || themeColor || logoUrl) {
            const appearanceResp = await adminFetch(`/api/admin/schools/${code}`, {
                method: 'PUT',
                body: JSON.stringify({ name, shortName, themeColor, logoUrl })
            });
            const appearanceJson = await appearanceResp.json().catch(() => ({}));
            if (!appearanceResp.ok) {
                throw new Error('学校已创建，但外观信息保存失败：' + (appearanceJson.error || appearanceJson.details || '未知错误'));
            }
        }

        const createdUsername = (json.data && json.data.adminUsername) || adminUsername || 'manager';
        showNotice(`✅ 学校 ${code} 创建成功（登录入口 ${schoolLoginUrl(code)}，初始账号 ${createdUsername}）`, 'success');
        closeCreateModal();
        loadSchools();
    } catch (e) {
        showNotice('❌ ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btnText.textContent = '创建学校';
    }
});
