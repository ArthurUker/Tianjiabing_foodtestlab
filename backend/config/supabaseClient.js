/**
 * Supabase 客户端配置
 * 用于后端与 Supabase 数据库通信
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// 确保环境变量被加载
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('缺少 SUPABASE_URL 或 SUPABASE_KEY 环境变量');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export default supabase;
