#!/bin/bash
# GeoRhizome AI - Mac/Linux Installer

echo "============================================================"
echo "  GeoRhizome AI Enterprise Edition - System Installer"
echo "============================================================"

# 1. Check Docker
echo "[INFO] 実行環境を確認しています..."
if ! docker info > /dev/null 2>&1; then
    echo "[ERROR] Docker Desktop が起動していないか、インストールされていません。"
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
# Decode the obfuscated read-only token in memory
ENCODED_TOKEN="Z2hwX3pxVzhIN3UwaTY3b1hwUjhCT1dUV0Z1QTIzNm9sRzBrdVh2Qw=="
GHCR_READ_TOKEN=$(echo "$ENCODED_TOKEN" | base64 --decode)
    echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u BAIZ1D --password-stdin > /dev/null 2>&1
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
      - STORAGE_DIR=/app/server/storage
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
        pkill -f local_bge_server.py
        pkill -f local_reranker_server.py
        pkill -f hardware_server.py
        pkill -f llama_cpp.server
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

echo "[INFO] ネイティブAI推論サーバーを起動しています..."
source "$HOME/.georhizome/source/.venv/bin/activate"

# Start BGE Embedder
nohup python3 "$HOME/.georhizome/source/local_bge_server.py" > "$HOME/.georhizome/bge.log" 2>&1 &
# Start Reranker
nohup python3 "$HOME/.georhizome/source/services/local_reranker_server.py" > "$HOME/.georhizome/reranker.log" 2>&1 &
# Start Hardware Server
nohup python3 "$HOME/.georhizome/source/services/hardware_server.py" > "$HOME/.georhizome/hardware.log" 2>&1 &

echo "[SUCCESS] 全てのシステムが起動しました！"

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

# 5b. Generate OTA Update Shortcut
cat << 'EOF_UPDATE' > "$INSTALL_DIR/update_georhizome.command"
#!/bin/bash
echo "------------------------------------------------------------"
echo "[INFO] GeoRhizome AI のアップデートを確認しています..."
cd "$HOME/.georhizome"
echo "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" | docker login ghcr.io -u BAIZ1D --password-stdin > /dev/null 2>&1
docker compose pull
echo ""
echo "[SUCCESS] アップデートが完了しました！"
echo "最新の機能を利用するには、現在開いている GeoRhizome AI を一度閉じて、再度起動してください。"
echo "------------------------------------------------------------"
sleep 5
EOF_UPDATE

chmod +x "$INSTALL_DIR/update_georhizome.command"


# 6. Desktop Shortcut

echo "------------------------------------------------------------"
echo "[STEP] AI推論エンジンのネイティブ環境を構築中 (Python / Metal API)..."

# Download the python source code natively
mkdir -p "$INSTALL_DIR/source"
echo "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" > "$INSTALL_DIR/git_token.txt"
curl -s -H "Authorization: token $(cat "$INSTALL_DIR/git_token.txt")" -L https://api.github.com/repos/BAIZ1D/GeoRhizome_AI-LTS/tarball/main | tar -xz -C "$INSTALL_DIR/source" --strip-components=1
rm "$INSTALL_DIR/git_token.txt"

# Ensure Python is installed
if ! command -v python3 > /dev/null 2>&1; then
    echo "[ERROR] Python3 が見つかりません。Homebrew等でインストールしてください。"
    exit 1
fi

cd "$INSTALL_DIR/source"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip > /dev/null 2>&1
echo "   🟢 依存パッケージをインストールしています (数分かかる場合があります)..."
pip install torch torchvision torchaudio > /dev/null 2>&1
CMAKE_ARGS="-DLLAMA_METAL=on" pip install llama-cpp-python > /dev/null 2>&1
pip install fastapi uvicorn sentence-transformers psutil pyyaml > /dev/null 2>&1
echo "   🟢 ネイティブAI環境の構築が完了しました！"


echo "[STEP] デスクトップにショートカットを作成しています..."
if [ "$OS_TYPE" = "Darwin" ]; then
    osacompile -e "do shell script \"open \\\"$INSTALL_DIR/start_georhizome.command\\\"\"" -o "$HOME/Desktop/GeoRhizome AI.app" > /dev/null 2>&1

    osacompile -e "do shell script \"open \\\"$INSTALL_DIR/update_georhizome.command\\\"\"" -o "$HOME/Desktop/Update GeoRhizome AI.app" > /dev/null 2>&1

else
    cat << 'EOF_LINUX' > "$HOME/Desktop/GeoRhizome_AI.desktop"
[Desktop Entry]
Name=GeoRhizome AI
Exec=sh -c 'cd ~/.georhizome && ./start_georhizome.command'
Terminal=true
Type=Application
EOF_LINUX
    chmod +x "$HOME/Desktop/GeoRhizome_AI.desktop"

    cat << 'EOF_LINUX_UPD' > "$HOME/Desktop/Update_GeoRhizome_AI.desktop"
[Desktop Entry]
Name=Update GeoRhizome AI
Exec=sh -c 'cd ~/.georhizome && ./update_georhizome.command'
Terminal=true
Type=Application
EOF_LINUX_UPD
    chmod +x "$HOME/Desktop/Update_GeoRhizome_AI.desktop"
fi

echo "[STEP] クラスタの初期化とコンテナのダウンロードを開始します..."
cd "$INSTALL_DIR"
echo "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" | docker login ghcr.io -u BAIZ1D --password-stdin > /dev/null 2>&1
docker compose pull

echo "------------------------------------------------------------"
echo "[SUCCESS] GeoRhizome AI のインストールが正常に完了しました。"
echo "[INFO] デスクトップの「GeoRhizome AI」アイコンから起動できます！"
echo "============================================================"
