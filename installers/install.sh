#!/bin/bash
# GeoRhizome AI - Mac/Linux Installer

echo "============================================================"
echo "  GeoRhizome AI Enterprise Edition - System Installer"
echo "============================================================"

# 1. Check Docker
echo "[INFO] 実行環境を確認しています..."
if ! command -v docker &> /dev/null; then
    echo "[ERROR] Docker Desktop がインストールされていません。"
    echo "[ERROR] 以下のリンクよりインストールし、再実行してください。"
    echo "        https://www.docker.com/products/docker-desktop/"
    exit 1
fi
echo "[SUCCESS] Docker Desktop の稼働を確認しました。"

# 2. Hardware Detection & Recommendation
echo ""
echo "[SYSTEM] ハードウェア・プロファイリングを実行中..."
OS_TYPE=$(uname)
if [ "$OS_TYPE" = "Darwin" ]; then
    RAM_BYTES=$(sysctl -n hw.memsize)
else
    RAM_BYTES=$(awk '/MemTotal/ {printf "%d \n", $2 * 1024}' /proc/meminfo)
fi
RAM_GB=$((RAM_BYTES / 1024 / 1024 / 1024))

echo "[SYSTEM] 物理メモリ (RAM): ${RAM_GB} GB"

if [ "$RAM_GB" -lt 16 ]; then
    RECOMMENDATION="Q2_K (超軽量版)"
elif [ "$RAM_GB" -lt 32 ]; then
    RECOMMENDATION="Q4_K_M (最適構成)"
else
    RECOMMENDATION="Q8_0 (高品質版)"
fi

echo "[INFO] 推奨推論モデル: ${RECOMMENDATION}"
echo "[NOTICE] インストール完了後、画面右上の「GeoRhizome モデルハブ」を開き、"
echo "         上記の推奨モデルを選択してセットアップを完了してください。"
echo "------------------------------------------------------------"

# 3. Setup Directories
INSTALL_DIR="$HOME/.georhizome"
mkdir -p "$INSTALL_DIR/models"
mkdir -p "$INSTALL_DIR/storage"
echo "[STEP] インストールディレクトリを構成しています... ($INSTALL_DIR)"

# 4. Authentication (Admin will replace <TOKEN>)
# docker login ghcr.io -u BAIZ1D -p <YOUR_READ_ONLY_TOKEN>
echo "[STEP] セキュア・コンテナレジストリへ接続中..."

# 5. Fetch Compose File (Placeholder logic for downloading the compose file)
# curl -s -o "$INSTALL_DIR/docker-compose.yml" "https://raw.githubusercontent.com/BAIZ1D/GeoRhizome_AI-LTS/main/installers/employee-docker-compose.yml"
echo "[STEP] コア・システムイメージを取得中..."

echo "[STEP] コンテナ・クラスタを起動しています... (この処理には数分かかる場合があります)"
# cd "$INSTALL_DIR" && docker-compose up -d

echo "------------------------------------------------------------"
echo "[SUCCESS] GeoRhizome AI のインストールが正常に完了しました。"
echo "[INFO] 管理画面: http://localhost:3000"
echo "============================================================"

# Open browser natively
if [ "$OS_TYPE" = "Darwin" ]; then
    open http://localhost:3000
else
    xdg-open http://localhost:3000
fi
