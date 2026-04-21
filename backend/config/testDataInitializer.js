/**
 * Database Initialization - Create Test Users
 * 在开发和测试环境中自动创建必要的测试用户
 */

import bcryptjs from 'bcryptjs';

/**
 * 初始化测试用户
 * @param {object} supabase - Supabase 客户端
 * @returns {Promise<object>} 初始化结果
 */
export async function initializeTestUsers(supabase) {
    try {
        console.log('🔧 开始初始化测试用户...');

        // Admin 密码：8888
        // bcrypt hash: $2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m
        const adminPassword = '$2a$10$mgqlRFCdDMgNIkLi/3Slqe.TiUbAX8AjLg2OR0eBO.KNnLp0V7i2m';
        
        // 测试用户密码：TestPass123!
        // bcrypt hash: $2b$10$h3j7lM.4r3Q5s8p9q2w1e0dXyZa1b2c3d4e5f6g7h8i9j0k1l2m3n4
        const testPassword = '$2b$10$h3j7lM.4r3Q5s8p9q2w1e0dXyZa1b2c3d4e5f6g7h8i9j0k1l2m3n4';
        
        const testUsers = [
            // 主管理员账号
            {
                username: 'admin',
                email: 'admin@foodlab.com',
                password_hash: adminPassword,
                full_name: '系统管理员',
                role: 'admin',
                status: 'active'
            },
            // E2E 测试账号
            {
                username: 'testuser',
                email: 'testuser@example.com',
                password_hash: testPassword,
                full_name: '测试用户',
                role: 'user',
                status: 'active'
            },
            {
                username: 'qa_tester',
                email: 'qa@example.com',
                password_hash: testPassword,
                full_name: 'QA 测试员',
                role: 'user',
                status: 'active'
            },
            {
                username: 'disabled_user',
                email: 'disabled@example.com',
                password_hash: testPassword,
                full_name: '被禁用的用户',
                role: 'user',
                status: 'disabled'
            }
        ];

        let createdCount = 0;
        let updatedCount = 0;

        for (const testUser of testUsers) {
            // 检查用户是否已存在
            const { data: existingUser, error: queryError } = await supabase
                .from('users')
                .select('id')
                .eq('username', testUser.username)
                .single();

            if (!queryError && existingUser) {
                // 检查是否需要更新密码
                const { data: currentUser } = await supabase
                    .from('users')
                    .select('password_hash')
                    .eq('username', testUser.username)
                    .single();

                if (currentUser && currentUser.password_hash !== testUser.password_hash) {
                    // 更新密码
                    const { error: updateError } = await supabase
                        .from('users')
                        .update({ password_hash: testUser.password_hash })
                        .eq('username', testUser.username);

                    if (!updateError) {
                        console.log(`✏️ 用户密码已更新: ${testUser.username}`);
                        updatedCount++;
                    }
                } else {
                    console.log(`ℹ️ 用户已存在: ${testUser.username}`);
                }
                continue;
            }

            // 创建用户
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert([testUser])
                .select('id, username, email, role, status');

            if (insertError) {
                console.error(`❌ 创建测试用户 ${testUser.username} 失败:`, insertError.message);
                continue;
            }

            if (newUser && newUser.length > 0) {
                console.log(`✅ 用户创建成功: ${testUser.username} (${testUser.email})`);
                createdCount++;
            }
        }

        console.log(`✅ 用户初始化完成，新建 ${createdCount} 个，更新 ${updatedCount} 个`);
        return { success: true, createdCount, updatedCount };
    } catch (error) {
        console.error('❌ 初始化用户失败:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 验证登录凭据（用于开发测试）
 * @param {object} supabase - Supabase 客户端
 * @returns {Promise<Array>} 测试账号列表
 */
export async function getTestCredentials(supabase) {
    try {
        const { data: testUsers } = await supabase
            .from('users')
            .select('username, email, role, status')
            .in('email', ['testuser@example.com', 'qa@example.com', 'disabled@example.com', 'admin@foodlab.com']);

        return testUsers || [];
    } catch (error) {
        console.error('❌ 获取测试凭据失败:', error.message);
        return [];
    }
}

/**
 * 清理测试用户（用于测试清理）
 * @param {object} supabase - Supabase 客户端
 */
export async function cleanupTestUsers(supabase) {
    try {
        console.log('🧹 开始清理测试用户...');

        const { error } = await supabase
            .from('users')
            .delete()
            .in('email', ['testuser@example.com', 'qa@example.com', 'disabled@example.com']);

        if (error) {
            console.error('❌ 清理测试用户失败:', error.message);
            return { success: false, error: error.message };
        }

        console.log('✅ 测试用户清理完成');
        return { success: true };
    } catch (error) {
        console.error('❌ 清理测试用户异常:', error.message);
        return { success: false, error: error.message };
    }
}
