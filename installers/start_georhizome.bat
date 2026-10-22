@echo off
setlocal
title GeoRhizome AI Enterprise Edition
chcp 65001 >nul
rem The chat model is resolved from config (active_models.json -> app_config.json llm) by georhizome_setup.py.
set "GR=%USERPROFILE%\.georhizome"
set "SRC=%GR%\source"
set "PY=%SRC%\.venv\Scripts\python.exe"
set "HELPER=%SRC%\installers\georhizome_setup.py"
set "LOGS=%GR%\logs"
if not exist "%LOGS%" mkdir "%LOGS%"
echo ============================================================
echo   GeoRhizome AI Enterprise Edition - 起動ツール
echo ============================================================
cd /d "%GR%"

set "PATH=%SRC%\.venv\Lib\site-packages\torch\lib;%PATH%"
set PYTHONIOENCODING=utf-8
"%PY%" "%HELPER%" write-env --env "%SRC%\georhizome-ai-source\server\.env"
if errorlevel 1 echo [WARN] server\.env の生成に失敗しました。

echo [INFO] Starting Local Embedder (Port 8000)... log: %LOGS%\bge.log
start "" /b "%PY%" "%SRC%\services\local_bge_server.py" > "%LOGS%\bge.log" 2>&1
echo [INFO] Starting Local Reranker Server (Port 8001)... log: %LOGS%\reranker.log
start "" /b "%PY%" "%SRC%\services\local_reranker_server.py" > "%LOGS%\reranker.log" 2>&1
echo [INFO] Starting Hardware ^& Model Hub Server (Port 8002)... log: %LOGS%\hardware.log
start "" /b "%PY%" "%SRC%\services\hardware_server.py" > "%LOGS%\hardware.log" 2>&1

set "LLM_PATH="
for /f "usebackq delims=" %%M in (`""%PY%" "%HELPER%" llm-path --models-dir "%GR%\storage\models""`) do set "LLM_PATH=%%M"
if not defined LLM_PATH goto llm_missing
if not exist "%LLM_PATH%" goto llm_missing
echo [INFO] Starting Local Chat LLM Server (Port 8003): %LLM_PATH%
set "LLM_DEGRADE="
type nul > "%LOGS%\chat.log"
:llm_launch
rem llm-args runs once normally and once with --degrade (llm-args --degrade) on fallback
set "LLM_ARGS="
for /f "delims=" %%A in ('""%PY%" "%HELPER%" llm-args %LLM_DEGRADE%"') do set "LLM_ARGS=%%A"
start "" /b "%PY%" -m llama_cpp.server --model "%LLM_PATH%" %LLM_ARGS% --n_gpu_layers -1 --port 8003 --host 127.0.0.1 >> "%LOGS%\chat.log" 2>&1
set /a TRIES=0
:wait_llm
timeout /t 2 >nul
netstat -ano | findstr ":8003" | findstr "LISTENING" >nul
if not errorlevel 1 goto llm_ok
findstr /i /c:"requires flash" "%LOGS%\chat.log" >nul 2>&1
if not errorlevel 1 goto llm_failed
set /a TRIES+=1
if %TRIES% lss 30 goto wait_llm
:llm_failed
if defined LLM_DEGRADE goto llm_dead
echo [WARN] Chat LLM Server did not open port 8003 with quantized KV; retrying with f16 KV cache (same n_ctx).
echo [WARN] degraded: f16 KV fallback>>"%LOGS%\chat.log"
wmic process where "commandline like '%%llama_cpp.server%%'" call terminate >nul 2>&1
set "LLM_DEGRADE=--degrade"
goto llm_launch
:llm_dead
echo [ERROR] Chat LLM Server が起動していません。ログ: %LOGS%\chat.log
powershell -NoProfile -Command "Get-Content -Tail 20 '%LOGS%\chat.log'"
goto llm_done
:llm_missing
echo [ERROR] チャットモデルが見つかりません (%LLM_PATH%)。モデルハブから再ダウンロードしてください。
goto llm_done
:llm_ok
echo [SUCCESS] Chat LLM Server が起動しました。
:llm_done

docker compose up -d >> "%LOGS%\docker.log" 2>&1
if errorlevel 1 echo [ERROR] docker compose up に失敗しました。ログ: %LOGS%\docker.log
set /a PIPTRIES=0
:retry_pip
docker exec georhizome-core pip3 install --break-system-packages PyMuPDF pymupdf4llm markitdown pytesseract >> "%LOGS%\docker.log" 2>&1
if not errorlevel 1 goto pip_done
set /a PIPTRIES+=1
if %PIPTRIES% geq 30 (
    echo [WARN] コンテナ内 OCR パッケージの導入に失敗しました。ログ: %LOGS%\docker.log
    goto pip_done
)
timeout /t 2 >nul
goto retry_pip
:pip_done

echo [SUCCESS] システムが起動しました！ブラウザを開きます...
start http://localhost:3001
echo ------------------------------------------------------------
echo [NOTICE] ⚠️ 注意: 終了する場合はこの画面で「Enter」キーを押してください。
pause >nul
echo [INFO] GeoRhizome AI をシャットダウンしています...
docker compose down >> "%LOGS%\docker.log" 2>&1
wmic process where "commandline like '%%local_bge_server.py%%'" call terminate >nul 2>&1
wmic process where "commandline like '%%local_reranker_server.py%%'" call terminate >nul 2>&1
wmic process where "commandline like '%%hardware_server.py%%'" call terminate >nul 2>&1
wmic process where "commandline like '%%llama_cpp.server%%'" call terminate >nul 2>&1
echo [SUCCESS] システムのシャットダウンが完了しました。
timeout /t 3 >nul
