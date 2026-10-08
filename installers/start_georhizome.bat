@echo off
title GeoRhizome AI Enterprise Edition
chcp 65001 >nul
echo ============================================================
echo   GeoRhizome AI Enterprise Edition - 起動ツール
echo ============================================================
cd %USERPROFILE%\.georhizome

if not exist "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server" mkdir "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server"
if not exist "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env" (
    echo LLM_PROVIDER=generic-openai> "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env"
    echo GENERIC_OPEN_AI_BASE_PATH=http://host.docker.internal:8003/v1>> "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env"
    echo GENERIC_OPEN_AI_API_KEY=sk-local>> "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env"
    echo GENERIC_OPEN_AI_MODEL_PREF=Qwen3.5-0.8B-Japanese-SFT-v2-Q4_K_M.gguf>> "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env"
    echo EMBEDDING_ENGINE=generic-openai>> "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env"
    echo EMBEDDING_BASE_PATH=http://host.docker.internal:8000/v1>> "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env"
    echo EMBEDDING_MODEL_PREF=cl-nagoya/ruri-v3-310m>> "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env"
    echo VECTOR_DB=lancedb>> "%USERPROFILE%\.georhizome\source\georhizome-ai-source\server\.env"
)

echo [INFO] Starting Local BGE Embedder (Port 8000)...
start /b "" "%USERPROFILE%\.georhizome\source\.venv\Scripts\python.exe" "%USERPROFILE%\.georhizome\source\local_bge_server.py" >nul 2>&1
echo [INFO] Starting Local Reranker Server (Port 8001)...
start /b "" "%USERPROFILE%\.georhizome\source\.venv\Scripts\python.exe" "%USERPROFILE%\.georhizome\source\services\local_reranker_server.py" >nul 2>&1
echo [INFO] Starting Hardware ^& Model Hub Server (Port 8002)...
start /b "" "%USERPROFILE%\.georhizome\source\.venv\Scripts\python.exe" "%USERPROFILE%\.georhizome\source\services\hardware_server.py" >nul 2>&1
echo [INFO] Starting Local Chat LLM Server (Port 8003)...
start /b "" "%USERPROFILE%\.georhizome\source\.venv\Scripts\python.exe" -m llama_cpp.server --model "%USERPROFILE%\.georhizome\storage\models\Qwen3.5-0.8B-Japanese-SFT-v2-Q4_K_M.gguf" --n_ctx 16384 --n_gpu_layers -1 --port 8003 --host 127.0.0.1 >nul 2>&1

docker compose up -d >nul 2>&1
docker exec georhizome-core pip3 install --break-system-packages PyMuPDF markitdown pytesseract >nul 2>&1

echo [SUCCESS] システムが起動しました！ブラウザを開きます...
start http://localhost:3001
echo ------------------------------------------------------------
echo [NOTICE] ⚠️ 注意: 終了する場合はこの画面で「Enter」キーを押してください。
pause >nul
echo [INFO] GeoRhizome AI をシャットダウンしています...
docker compose down >nul 2>&1
wmic process where "commandline like '%%local_bge_server.py%%'" call terminate >nul 2>&1
wmic process where "commandline like '%%local_reranker_server.py%%'" call terminate >nul 2>&1
wmic process where "commandline like '%%hardware_server.py%%'" call terminate >nul 2>&1
wmic process where "commandline like '%%llama_cpp.server%%'" call terminate >nul 2>&1
echo [SUCCESS] システムのシャットダウンが完了しました。
timeout /t 3 >nul
