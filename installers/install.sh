#!/bin/bash
# GeoRhizome AI - Mac/Linux Installer
# Default models (LLM, embedder, reranker) come from config/app_config.json via
# installers/georhizome_setup.py; nothing model-specific is hardcoded here.
set -eo pipefail

fail() { echo "[ERROR] $*" >&2; exit 1; }
trap 'echo "[ERROR] インストールが失敗しました (line $LINENO)。上記のエラー出力を確認してください。" >&2' ERR

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
echo "[NOTICE] 既定モデルは自動でダウンロードされます。変更は「GeoRhizome モデルハブ」から行えます。"
echo "------------------------------------------------------------"

# 3. Setup Directories
INSTALL_DIR="$HOME/.georhizome"
SOURCE_DIR="$INSTALL_DIR/source"
MODELS_DIR="$INSTALL_DIR/storage/models"
mkdir -p "$INSTALL_DIR/storage" "$MODELS_DIR" "$SOURCE_DIR" "$INSTALL_DIR/logs"
echo "[STEP] インストールディレクトリを構成しています... ($INSTALL_DIR)"

# 4. The GHCR image and GitHub repo are public: no token or registry login needed.

# 5. Download the source (services, config, installers)
echo "[STEP] ソースコードをダウンロードしています..."
curl -fsSL https://api.github.com/repos/BAIZ1D/GeoRhizome_AI-LTS/tarball/main \
    | tar -xz -C "$SOURCE_DIR" --strip-components=1
rm -rf "$SOURCE_DIR/models"
ln -s "$MODELS_DIR" "$SOURCE_DIR/models"

# 6. Compose file (model preferences live in server/.env, which the Model Hub updates)
cat << 'EOF_COMPOSE' > "$INSTALL_DIR/docker-compose.yml"
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
      - ./storage/hotdir:/app/collector/hotdir
      - ./storage/outputs:/app/collector/outputs
      - ./source/config:/config
      - ./source/georhizome-ai-source/server/.env:/app/server/.env
    environment:
      - NODE_ENV=production
      - STORAGE_DIR=/app/server/storage
      - HARDWARE_SERVER_URL=http://host.docker.internal:8002
    restart: unless-stopped
EOF_COMPOSE

# 7. Python runtime (torch==2.5.1 ships wheels for Python 3.10-3.12 only)
echo "[STEP] AI推論エンジンのネイティブ環境を構築中 (Python / Metal API)..."
PYTHON_BIN=""
for cand in python3.12 python3.11 python3.10 python3; do
    if command -v "$cand" > /dev/null 2>&1 && "$cand" -c "import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 13) else 1)"; then
        PYTHON_BIN="$cand"
        break
    fi
done
[ -n "$PYTHON_BIN" ] || fail "Python 3.10〜3.12 が見つかりません (Python 3.10 以上が必要、torch 2.5.1 は 3.13 以降未対応)。例: brew install python@3.12"
echo "[INFO] Python: $("$PYTHON_BIN" --version)"

cd "$SOURCE_DIR"
if [ -x .venv/bin/python3 ] && ! .venv/bin/python3 -c "import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 13) else 1)"; then
    echo "[INFO] 既存の .venv は非対応の Python のため再作成します。"
    rm -rf .venv
fi
"$PYTHON_BIN" -m venv .venv
VENV_PYTHON="$SOURCE_DIR/.venv/bin/python3"
HELPER="$SOURCE_DIR/installers/georhizome_setup.py"

echo "   依存パッケージをインストールしています (数分かかる場合があります)..."
"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1
if [ "$OS_TYPE" = "Darwin" ]; then
    CMAKE_ARGS="-DGGML_METAL=on" "$VENV_PYTHON" -m pip install "llama-cpp-python[server]==0.3.4"
else
    "$VENV_PYTHON" -m pip install "llama-cpp-python[server]==0.3.4"
fi
"$VENV_PYTHON" -m pip install "transformers==5.18.0" "sentence-transformers==6.1.0" "huggingface_hub>=1.31,<2" \
    fastapi uvicorn psutil pyyaml requests
echo "   ネイティブAI環境の構築が完了しました。"

# 8. server/.env (created if missing) + legacy-default migration on re-install
SERVER_ENV="$SOURCE_DIR/georhizome-ai-source/server/.env"
"$VENV_PYTHON" "$HELPER" write-env --env "$SERVER_ENV"
"$VENV_PYTHON" "$HELPER" migrate --env "$SERVER_ENV"

# 9. Default models: LLM GGUF -> storage/models, embedder + reranker -> default HF cache
echo "[STEP] デフォルトのAIモデルをダウンロードしています (初期化用)..."
"$VENV_PYTHON" "$SOURCE_DIR/installers/georhizome_setup.py" download --models-dir "$MODELS_DIR"

# 10. Launcher + OTA updater
cp "$SOURCE_DIR/installers/start_georhizome.command" "$INSTALL_DIR/start_georhizome.command"
chmod +x "$INSTALL_DIR/start_georhizome.command"

cat << 'EOF_UPDATE' > "$INSTALL_DIR/update_georhizome.command"
#!/bin/bash
set -eo pipefail
trap 'echo "[ERROR] アップデートに失敗しました (line $LINENO)。" >&2; sleep 10' ERR
GR="$HOME/.georhizome"
echo "------------------------------------------------------------"
echo "[INFO] GeoRhizome AI のアップデートを確認しています..."
cd "$GR"
docker compose pull
echo "[INFO] ネイティブAIエンジンのアップデートを確認しています..."
curl -fsSL https://api.github.com/repos/BAIZ1D/GeoRhizome_AI-LTS/tarball/main \
    | tar -xz -C "$GR/source" --strip-components=1
cp "$GR/source/installers/start_georhizome.command" "$GR/start_georhizome.command"
chmod +x "$GR/start_georhizome.command"
"$GR/source/.venv/bin/python3" "$GR/source/installers/georhizome_setup.py" migrate --env "$GR/source/georhizome-ai-source/server/.env"
echo ""
echo "[SUCCESS] アップデートが完了しました！"
echo "最新の機能を利用するには、現在開いている GeoRhizome AI を一度閉じて、再度起動してください。"
echo "------------------------------------------------------------"
sleep 5
EOF_UPDATE
chmod +x "$INSTALL_DIR/update_georhizome.command"

# 11. Desktop shortcuts
echo "[STEP] デスクトップにショートカットを作成しています..."
if [ "$OS_TYPE" = "Darwin" ]; then
    osacompile -e "do shell script \"open \\\"$INSTALL_DIR/start_georhizome.command\\\"\"" -o "$HOME/Desktop/GeoRhizome AI.app"
    osacompile -e "do shell script \"open \\\"$INSTALL_DIR/update_georhizome.command\\\"\"" -o "$HOME/Desktop/Update GeoRhizome AI.app"
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

# 12. Container image
echo "[STEP] クラスタの初期化とコンテナのダウンロードを開始します..."
cd "$INSTALL_DIR"
docker compose pull

echo "------------------------------------------------------------"
echo "[SUCCESS] GeoRhizome AI のインストールが正常に完了しました。"
echo "[INFO] デスクトップの「GeoRhizome AI」アイコンから起動できます！"
echo "============================================================"
