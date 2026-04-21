#!/usr/bin/env node

/**
 * 测试 Supabase 连接和 API 密钥
 * 快速诊断 Supabase 连接问题
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

console.log('\n╔════════════════════════════════════════╗');
console.log('║  🧪 Supabase 连接诊断工具              ║');
console.log('╚════════════════════════════════════════╝\n');

// Step 1: 检查环境变量
console.log('📋 Step 1: 检查环境变量');
console.log('─'.repeat(50));

if (!SUPABASE_URL) {
    console.error('❌ SUPABASE_URL 未定义');
    process.exit(1);
}

if (!SUPABASE_KEY) {
    console.error('❌ SUPABASE_KEY 未定义');
    process.exit(1);
}

console.log(`✅ SUPABASE_URL: ${SUPABASE_URL}`);
console.log(`✅ SUPABASE_KEY: ${SUPABASE_KEY.substring(0, 20)}...${SUPABASE_KEY.substring(SUPABASE_KEY.length - 10)}`);

// Step 2: 创建 Supabase 客户端
console.log('\n📋 Step 2: 创建 Supabase 客户端');
console.log('─'.repeat(50));

let supabase;
try {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('✅ Supabase 客户端创建成功');
} catch (error) {
    console.error('❌ 创建客户端失败:', error.message);
    process.exit(1);
}

// Step 3: 测试连接
console.log('\n📋 Step 3: 测试数据库连接');
console.log('─'.repeat(50));

try {
    const { data, error } = await supabase
        .from('users')
        .select('count')
        .limit(1);

    if (error) {
        console.error('❌ 数据库查询失败:');
        console.error('   错误代码:', error.code);
        console.error('   错误信息:', error.message);
        console.error('   详细信息:', error);
        
        console.log('\n💡 可能的解决方案:');
        
        if (error.message.includes('Invalid API key')) {
            console.log('   1️⃣  您的 API key 无效或已过期');
            console.log('   2️⃣  访问 Supabase 项目页面检查密钥');
            console.log('   3️⃣  复制正确的 anon/public key');
            console.log('   4️⃣  更新 backend/.env 文件中的 SUPABASE_KEY');
            console.log('   5️⃣  重启后端服务');
        } else if (error.message.includes('Failed to fetch')) {
            console.log('   1️⃣  网络连接问题');
            console.log('   2️⃣  检查您的网络连接');
            console.log('   3️⃣  检查 SUPABASE_URL 是否正确');
        } else if (error.message.includes('does not exist')) {
            console.log('   1️⃣  表 "users" 不存在');
            console.log('   2️⃣  运行数据库初始化脚本');
            console.log('   3️⃣  检查 sql/01_users_schema.sql');
        }
        
        process.exit(1);
    }

    console.log('✅ 数据库连接成功');
    console.log(`   查询结果: ${JSON.stringify(data)}`);
} catch (error) {
    console.error('❌ 连接测试异常:', error.message);
    process.exit(1);
}

// Step 4: 测试插入数据
console.log('\n📋 Step 4: 测试创建测试数据');
console.log('─'.repeat(50));

try {
    const testData = {
        username: 'connection_test_' + Date.now(),
        email: `test_${Date.now()}@example.com`,
        password_hash: '$2a$10$test',
        full_name: '连接测试账号',
        role: 'user',
        status: 'active'
    };

    const { data, error } = await supabase
        .from('users')
        .insert([testData])
        .select('id, username, email');

    if (error) {
        console.error('❌ 插入数据失败:', error.message);
        process.exit(1);
    }

    console.log('✅ 插入数据成功');
    console.log(`   新用户: ${data[0].username}`);

    // 清理测试数据
    const { error: deleteError } = await supabase
        .from('users')
        .delete()
        .eq('id', data[0].id);

    if (!deleteError) {
        console.log('✅ 测试数据已清理');
    }
} catch (error) {
    console.error('❌ 测试插入异常:', error.message);
    process.exit(1);
}

// 总结
console.log('\n╔════════════════════════════════════════╗');
console.log('║  ✅ 所有诊断测试通过！                  ║');
console.log('╚════════════════════════════════════════╝\n');

console.log('📝 下一步:');
console.log('   1️⃣  重启后端服务: npm run dev');
console.log('   2️⃣  检查初始化日志中的用户创建情况');
console.log('   3️⃣  尝试使用 admin/8888 登录\n');

process.exit(0);
