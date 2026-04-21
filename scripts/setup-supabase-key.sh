#!/bin/bash

# 交互式 Supabase 配置脚本
# 用于快速更新 SUPABASE_KEY

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  🔑 Supabase API Key 配置工具          ║"
echo "╚════════════════════════════════════════╝"
echo ""

# 检查 .env 文件
ENV_FILE="backend/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ 错误: 未找到 $ENV_FILE"
    echo "📝 请确保在项目根目录运行此脚本"
    exit 1
fi

echo "📋 当前配置:"
echo "─".repeat(50)
echo ""

# 显示当前配置
CURRENT_URL=$(grep "^SUPABASE_URL=" "$ENV_FILE" | cut -d'=' -f2)
CURRENT_KEY=$(grep "^SUPABASE_KEY=" "$ENV_FILE" | cut -d'=' -f2)

echo "SUPABASE_URL: $CURRENT_URL"

if [ -z "$CURRENT_KEY" ]; then
    echo "SUPABASE_KEY: (未设置)"
else
    KEY_START=${CURRENT_KEY:0:20}
    KEY_END=${CURRENT_KEY: -10}
    echo "SUPABASE_KEY: ${KEY_START}...${KEY_END}"
fi

echo ""
echo "🔗 如何获取密钥:"
echo "─".repeat(50)
echo ""
echo "1️⃣  访问: https://app.supabase.com"
echo "2️⃣  选择您的项目"
echo "3️⃣  点击: Settings → API"
echo "4️⃣  复制: ANON/PUBLIC KEY"
echo ""
read -p "✏️  请输入新的 SUPABASE_KEY: " NEW_KEY

if [ -z "$NEW_KEY" ]; then
    echo "❌ 密钥不能为空"
    exit 1
fi

echo ""
echo "💾 正在更新 .env 文件..."

# 备份原文件
cp "$ENV_FILE" "${ENV_FILE}.backup"
echo "✅ 备份已保存到: ${ENV_FILE}.backup"

# 更新密钥 (跨平台兼容的方式)
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s|^SUPABASE_KEY=.*|SUPABASE_KEY=$NEW_KEY|" "$ENV_FILE"
else
    # Linux
    sed -i "s|^SUPABASE_KEY=.*|SUPABASE_KEY=$NEW_KEY|" "$ENV_FILE"
fi

echo "✅ SUPABASE_KEY 已更新"
echo ""

# 验证更新
UPDATED_KEY=$(grep "^SUPABASE_KEY=" "$ENV_FILE" | cut -d'=' -f2)
if [ "$UPDATED_KEY" == "$NEW_KEY" ]; then
    echo "✅ 验证成功！新密钥已保存"
    echo ""
    echo "🚀 下一步:"
    echo "─".repeat(50)
    echo ""
    echo "1️⃣  测试连接:"
    echo "   node scripts/test-supabase-connection.js"
    echo ""
    echo "2️⃣  重启后端:"
    echo "   npm run dev"
    echo ""
else
    echo "❌ 验证失败！"
    echo "   恢复备份: cp ${ENV_FILE}.backup $ENV_FILE"
    exit 1
fi

echo ""
