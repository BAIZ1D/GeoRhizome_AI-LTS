#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "============================================================"
echo "  GeoRhizome AI Enterprise Edition - 起動ツール"
echo "============================================================"
cd "$HOME/.georhizome"

if [ ! -s "$HOME/.georhizome/source/georhizome-ai-source/server/.env" ]; then
cat << 'ENV_EOF' > "$HOME/.georhizome/source/georhizome-ai-source/server/.env"
LLM_PROVIDER=generic-openai
GENERIC_OPEN_AI_BASE_PATH=http://host.docker.internal:8003/v1
GENERIC_OPEN_AI_API_KEY=sk-local
GENERIC_OPEN_AI_MODEL_PREF=Qwen3.5-0.8B-Japanese-SFT-v2-Q4_K_M.gguf
EMBEDDING_ENGINE=generic-openai
EMBEDDING_BASE_PATH=http://host.docker.internal:8000/v1
EMBEDDING_MODEL_PREF=cl-nagoya/ruri-v3-310m
VECTOR_DB=lancedb
ENV_EOF
fi

echo "[INFO] GeoRhizome AI を起動しています..."
echo "[INFO] ネイティブAI推論サーバーを起動しています..."
VENV_PYTHON="$HOME/.georhizome/source/.venv/bin/python3"
nohup "$VENV_PYTHON" "$HOME/.georhizome/source/services/local_bge_server.py" > "$HOME/.georhizome/bge.log" 2>&1 &
nohup "$VENV_PYTHON" "$HOME/.georhizome/source/services/local_reranker_server.py" > "$HOME/.georhizome/reranker.log" 2>&1 &
nohup "$VENV_PYTHON" "$HOME/.georhizome/source/services/hardware_server.py" > "$HOME/.georhizome/hardware.log" 2>&1 &

# Determine and start Chat LLM Server on Port 8003
DEFAULT_MODEL=$("$VENV_PYTHON" -c "import json; print(json.load(open('$HOME/.georhizome/source/config/app_config.json')).get('llm', {}).get('model_name', 'Qwen3.5-0.8B-Japanese-SFT-v2-Q4_K_M.gguf'))" 2>/dev/null)
ACTIVE_CHAT_MODEL="${DEFAULT_MODEL:-Qwen3.5-0.8B-Japanese-SFT-v2-Q4_K_M.gguf}"
if [ -f "$HOME/.georhizome/source/config/active_models.json" ]; then
  FOUND_MODEL=$("$VENV_PYTHON" -c "import json; print(json.load(open('$HOME/.georhizome/source/config/active_models.json')).get('generative', {}).get('model_id', ''))" 2>/dev/null)
  if [ -n "$FOUND_MODEL" ] && [ "$FOUND_MODEL" != "Offloaded" ]; then
    ACTIVE_CHAT_MODEL="$FOUND_MODEL"
  fi
fi
if [ "$ACTIVE_CHAT_MODEL" != "Offloaded" ]; then
  echo "[INFO] Chat LLM Server ($ACTIVE_CHAT_MODEL) をポート 8003 で起動しています..."
  if [[ "$ACTIVE_CHAT_MODEL" == *.gguf ]]; then
    nohup "$VENV_PYTHON" -m llama_cpp.server --model "$HOME/.georhizome/storage/models/$ACTIVE_CHAT_MODEL" --n_ctx 16384 --n_gpu_layers -1 --port 8003 --host 127.0.0.1 > "$HOME/.georhizome/chat.log" 2>&1 &
  else
    nohup "$VENV_PYTHON" -m llama_cpp.server --hf_model_repo_id "$ACTIVE_CHAT_MODEL" --n_ctx 16384 --n_gpu_layers -1 --port 8003 --host 127.0.0.1 > "$HOME/.georhizome/chat.log" 2>&1 &
  fi
fi

nohup docker compose up -d > "$HOME/.georhizome/docker.log" 2>&1 &
sleep 3
docker exec georhizome-core pip3 install --break-system-packages PyMuPDF pymupdf4llm markitdown pytesseract >/dev/null 2>&1

sleep 5
open http://localhost:3001
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
