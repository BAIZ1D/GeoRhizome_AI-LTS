#!/bin/bash
# GeoRhizome AI - Mac/Linux Smart Shortcut

# Trap window close (SIGHUP) or script exit to spin down
cleanup() {
    echo ""
    echo "------------------------------------------------------------"
    echo "[INFO] GeoRhizome AI をシャットダウンしています..."
    echo "[INFO] コンテナと推論モデルを安全にアンロード中..."
    
    # Check if the directory exists to avoid errors
    if [ -d "$HOME/.georhizome" ]; then
        cd "$HOME/.georhizome" && docker compose down
    fi
    
    echo "[SUCCESS] システムのシャットダウンとメモリ解放が完了しました。"
    echo "ウィンドウを閉じます..."
    sleep 2
    exit 0
}
# Catch all terminal exit signals
trap cleanup EXIT SIGHUP SIGINT SIGTERM

echo "============================================================"
echo "  GeoRhizome AI Enterprise Edition - 起動ツール"
echo "============================================================"
echo "[INFO] GeoRhizome AI を起動しています..."

# Create directory just in case it doesn't exist
mkdir -p "$HOME/.georhizome"
cd "$HOME/.georhizome"

# If docker-compose.yml doesn't exist here (e.g. they ran this without installing), warn them
if [ ! -f "docker-compose.yml" ]; then
    echo "[ERROR] システムが見つかりません。先に install.sh を実行してください。"
    exit 1
fi

# Start the docker cluster in the background
docker compose up -d

echo "[SUCCESS] システムが起動しました！"
echo "[INFO] ブラウザを http://localhost:3000 に開きます..."

# Open browser
if [ "$(uname)" = "Darwin" ]; then
    open http://localhost:3000
else
    xdg-open http://localhost:3000
fi

echo "------------------------------------------------------------"
echo "[NOTICE] ⚠️ 注意: GeoRhizome AI を使用中は、このターミナルウィンドウを"
echo "         閉じないでください。"
echo "[NOTICE] 作業が完了し終了する場合は、このウィンドウを閉じるか、"
echo "         Ctrl+C を押してください。"
echo "         ※ すべての会話履歴とアップロードデータは安全に自動保存されています。"
echo "============================================================"

# Keep script running to maintain the trap listener
while true; do
    sleep 1
done
