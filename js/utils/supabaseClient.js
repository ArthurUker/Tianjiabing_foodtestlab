// 文件路径: js/utils/supabaseClient.js

// 1. 引入 Supabase 客户端 (使用 ESM CDN 版本，无需打包工具)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// 2. 配置信息 (提取自你的 Storage.js)
const SUPABASE_URL = 'https://mqnzaxwvyjtfktzqjugl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1xbnpheHd2eWp0Zmt0enFqdWdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYzODUwOTcsImV4cCI6MjA4MTk2MTA5N30.D0WfRNdUthCWG4LrXS4T0alem4ftBw6a2bn-qAwQt90';

// 3. 初始化并导出客户端实例
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
