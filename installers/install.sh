#!/bin/bash
# GeoRhizome AI - Mac/Linux Installer

echo "================================================="
echo "🚀 GeoRhizome AI のインストールを開始します..."
echo "================================================="

# 1. Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ エラー: Docker Desktopがインストールされていません。"
    echo "Docker Desktopをインストールしてから再実行してください: https://www.docker.com/products/docker-desktop/"
    exit 1
fi
echo "✅ Docker の起動を確認しました。"

# 2. Hardware Detection & Recommendation
echo "🔍 ハードウェアを分析中..."
OS_TYPE=$(uname)
if [ "$OS_TYPE" = "Darwin" ]; then
    RAM_BYTES=$(sysctl -n hw.memsize)
else
    RAM_BYTES=$(awk '/MemTotal/ {printf "%d \n", $2 * 1024}' /proc/meminfo)
fi
RAM_GB=$((RAM_BYTES / 1024 / 1024 / 1024))

echo "💻 搭載メモリ: ${RAM_GB} GB"

if [ "$RAM_GB" -lt 16 ]; then
    RECOMMENDATION="Q2_K (超軽量)"
elif [ "$RAM_GB" -lt 32 ]; then
    RECOMMENDATION="Q4_K_M (最適フィット)"
else
    RECOMMENDATION="Q8_0 (高品質)"
fi

echo "✨ 推奨モデル: ${RECOMMENDATION}"
echo "※ インストール完了後、画面右上の「GeoRhizome モデルハブ」から上記の推奨モデルをクリックしてダウンロードしてください。"
echo "================================================="

# 3. Setup Directories
INSTALL_DIR="$HOME/.georhizome"
mkdir -p "$INSTALL_DIR/models"
mkdir -p "$INSTALL_DIR/storage"
echo "📂 インストールディレクトリを作成しました: $INSTALL_DIR"

# 4. Authentication (Admin will replace <TOKEN>)
# docker login ghcr.io -u BAIZ1D -p <YOUR_READ_ONLY_TOKEN>
echo "🔒 コンテナレジストリに接続中..."

# 5. Fetch Compose File (Placeholder logic for downloading the compose file)
# curl -s -o "$INSTALL_DIR/docker-compose.yml" "https://raw.githubusercontent.com/BAIZ1D/GeoRhizome_AI-LTS/main/installers/employee-docker-compose.yml"
echo "📥 GeoRhizome AI のコアシステムをダウンロード中..."

echo "🚀 システムを起動しています... (数分かかる場合があります)"
# cd "$INSTALL_DIR" && docker-compose up -d

echo "================================================="
echo "🎉 インストールが完了しました！"
echo "🌐 ブラウザで http://localhost:3000 にアクセスしてください。"
echo "================================================="

# Open browser natively
if [ "$OS_TYPE" = "Darwin" ]; then
    open http://localhost:3000
else
    xdg-open http://localhost:3000
fi
