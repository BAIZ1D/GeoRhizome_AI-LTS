#!/bin/bash
# GeoRhizome AI launcher (macOS/Linux). The chat model is resolved from config
# (active_models.json -> app_config.json llm) by installers/georhizome_setup.py.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
GR="$HOME/.georhizome"
SRC="$GR/source"
VENV_PYTHON="$SRC/.venv/bin/python3"
HELPER="$SRC/installers/georhizome_setup.py"
LOG_DIR="$GR/logs"
mkdir -p "$LOG_DIR"

echo "============================================================"
echo "  GeoRhizome AI Enterprise Edition - 起動ツール"
echo "============================================================"
cd "$GR" || exit 1

"$VENV_PYTHON" "$HELPER" write-env --env "$SRC/georhizome-ai-source/server/.env" \
    || echo "[WARN] server/.env の生成に失敗しました。"

echo "[INFO] ネイティブAI推論サーバーを起動しています... (ログ: $LOG_DIR)"
nohup "$VENV_PYTHON" "$SRC/services/local_bge_server.py" > "$LOG_DIR/bge.log" 2>&1 &
nohup "$VENV_PYTHON" "$SRC/services/local_reranker_server.py" > "$LOG_DIR/reranker.log" 2>&1 &
nohup "$VENV_PYTHON" "$SRC/services/hardware_server.py" > "$LOG_DIR/hardware.log" 2>&1 &

# Chat LLM on port 8003 (model named in config)
if LLM_PATH=$("$VENV_PYTHON" "$HELPER" llm-path --models-dir "$GR/storage/models"); then
    echo "[INFO] Chat LLM Server ($(basename "$LLM_PATH")) をポート 8003 で起動しています..."
    LLM_ARGS=$("$VENV_PYTHON" "$HELPER" llm-args)
    # shellcheck disable=SC2086  # LLM_ARGS is fixed allow-listed flags from the helper
    nohup "$VENV_PYTHON" -m llama_cpp.server --model "$LLM_PATH" $LLM_ARGS --n_gpu_layers -1 \
        --port 8003 --host 127.0.0.1 > "$LOG_DIR/chat.log" 2>&1 &
    LLM_PID=$!
    # Bounded wait for port 8003; early exit only on the explicit failure text.
    for i in $(seq 1 30); do
        lsof -ti:8003 > /dev/null 2>&1 && break
        /usr/bin/grep -qi 'requires flash' "$LOG_DIR/chat.log" 2> /dev/null && break
        sleep 2
    done
    if ! lsof -ti:8003 > /dev/null 2>&1; then
        echo "[WARN] Chat LLM Server did not open port 8003 with quantized KV; retrying with f16 KV cache (same n_ctx)."
        echo "[WARN] degraded: f16 KV fallback" >> "$LOG_DIR/chat.log"
        kill "$LLM_PID" 2> /dev/null
        for p in $(lsof -ti:8003 2> /dev/null); do kill "$p" 2> /dev/null; done
        LLM_ARGS=$("$VENV_PYTHON" "$HELPER" llm-args --degrade)
        # shellcheck disable=SC2086
        nohup "$VENV_PYTHON" -m llama_cpp.server --model "$LLM_PATH" $LLM_ARGS --n_gpu_layers -1 \
            --port 8003 --host 127.0.0.1 >> "$LOG_DIR/chat.log" 2>&1 &
        LLM_PID=$!
        sleep 3
    fi
    if ! kill -0 "$LLM_PID" 2> /dev/null; then
        echo "[ERROR] Chat LLM Server の起動に失敗しました。ログ: $LOG_DIR/chat.log"
        tail -n 20 "$LOG_DIR/chat.log"
    fi
else
    echo "[ERROR] チャットモデルが見つかりません。モデルハブから再ダウンロードしてください。"
fi

if ! docker compose up -d >> "$LOG_DIR/docker.log" 2>&1; then
    echo "[ERROR] docker compose up に失敗しました。ログ: $LOG_DIR/docker.log"
fi
sleep 3
docker exec georhizome-core pip3 install --break-system-packages PyMuPDF pymupdf4llm markitdown pytesseract >> "$LOG_DIR/docker.log" 2>&1 \
    || echo "[WARN] コンテナ内 OCR パッケージの導入に失敗しました。ログ: $LOG_DIR/docker.log"

sleep 5
open http://localhost:3001 2> /dev/null || xdg-open http://localhost:3001 2> /dev/null
echo "[SUCCESS] 全てのシステムが起動しました！"
echo "------------------------------------------------------------"
echo "[NOTICE] ⚠️ 注意: 作業中はウィンドウを閉じないでください。"
echo "[NOTICE] 終了する場合はこのウィンドウを閉じてください。"
echo "============================================================"

cleanup() {
    echo "[INFO] GeoRhizome AI をシャットダウンしています..."
    docker compose down
    pkill -f local_bge_server.py
    pkill -f local_reranker_server.py
    pkill -f hardware_server.py
    pkill -f llama_cpp.server
    echo "[SUCCESS] シャットダウンが完了しました。"
    exit 0
}
trap cleanup EXIT INT TERM
while true; do sleep 1; done
