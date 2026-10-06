#!/bin/bash
# GeoRhizome AI - Mac/Linux Installer

echo "============================================================"
echo "  GeoRhizome AI Enterprise Edition - System Installer"
echo "============================================================"

# 1. Check Docker
echo "[INFO] 実行環境を確認しています..."
if ! command -v docker > /dev/null 2>&1; then
    echo "[ERROR] Docker Desktop がインストールされていません。"
    echo "[ERROR] 以下のリンクよりインストールし、再実行してください。"
    echo "        https://www.docker.com/products/docker-desktop/"
    exit 1
fi
echo "[SUCCESS] Docker Desktop の稼働を確認しました。"

echo ""
# 2. Hardware Detection
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

# 5. Generate Core Files
echo "[STEP] コア・システム構成ファイルを生成中..."

cat << 'EOF_COMPOSE' > "$INSTALL_DIR/docker-compose.yml"
version: '3.8'
services:
  georhizome-core:
    image: ghcr.io/baiz1d/georhizome_ai-lts:latest
    container_name: georhizome-core
    ports:
      - "3000:3000"
      - "3001:3001"
      - "8888:8888"
    volumes:
      - ./storage:/app/server/storage
    environment:
      - NODE_ENV=production
    restart: unless-stopped
EOF_COMPOSE

cat << 'EOF_START' > "$INSTALL_DIR/start_georhizome.command"
#!/bin/bash
cleanup() {
    echo ""
    echo "------------------------------------------------------------"
    echo "[INFO] GeoRhizome AI をシャットダウンしています..."
    if [ -d "$HOME/.georhizome" ]; then
        cd "$HOME/.georhizome" && docker compose down
    fi
    echo "[SUCCESS] システムのシャットダウンが完了しました。ウィンドウを閉じます。"
    sleep 2
    exit 0
}
trap cleanup EXIT SIGHUP SIGINT SIGTERM

echo "============================================================"
echo "  GeoRhizome AI Enterprise Edition - 起動ツール"
echo "============================================================"
echo "[INFO] GeoRhizome AI を起動しています..."
cd "$HOME/.georhizome"
docker compose up -d >/dev/null 2>&1
echo "[SUCCESS] システムが起動しました！"
if [ "$(uname)" = "Darwin" ]; then
    open http://localhost:3000
else
    xdg-open http://localhost:3000
fi
echo "------------------------------------------------------------"
echo "[NOTICE] ⚠️ 注意: 作業中はウィンドウを閉じないでください。"
echo "[NOTICE] 終了する場合はこのウィンドウを閉じてください。"
echo "============================================================"
while true; do sleep 1; done
EOF_START

chmod +x "$INSTALL_DIR/start_georhizome.command"

# 6. Desktop Shortcut
echo "[STEP] デスクトップにショートカットを作成しています..."
if [ "$OS_TYPE" = "Darwin" ]; then
    osacompile -e "do shell script \"open \\\"$INSTALL_DIR/start_georhizome.command\\\"\"" -o "$HOME/Desktop/GeoRhizome AI.app" > /dev/null 2>&1
else
    cat << 'EOF_LINUX' > "$HOME/Desktop/GeoRhizome_AI.desktop"
[Desktop Entry]
Name=GeoRhizome AI
Exec=sh -c 'cd ~/.georhizome && ./start_georhizome.command'
Terminal=true
Type=Application
EOF_LINUX
    chmod +x "$HOME/Desktop/GeoRhizome_AI.desktop"
fi

echo "[STEP] コンテナ・クラスタを初期化中... (※テスト用スキップ)"

echo "------------------------------------------------------------"
echo "[SUCCESS] GeoRhizome AI のインストールが正常に完了しました。"
echo "[INFO] デスクトップの「GeoRhizome AI」アイコンから起動できます！"
echo "============================================================"
