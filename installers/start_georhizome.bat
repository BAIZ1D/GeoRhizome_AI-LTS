@echo off
title GeoRhizome AI Enterprise Edition
chcp 65001 >nul

echo ============================================================
echo   GeoRhizome AI Enterprise Edition - 起動ツール
echo ============================================================
echo [INFO] GeoRhizome AI を起動しています...

if not exist "%USERPROFILE%\.georhizome\docker-compose.yml" (
    echo [ERROR] システムが見つかりません。先に install.ps1 を実行してください。
    pause
    exit
)

cd %USERPROFILE%\.georhizome

:: Start docker compose in background
docker compose up -d

echo [SUCCESS] システムが起動しました！
echo [INFO] ブラウザを http://localhost:3000 に開きます...

start http://localhost:3000

echo ------------------------------------------------------------
echo [NOTICE] ⚠️ 注意: GeoRhizome AI を使用中は、このウィンドウを
echo          閉じないでください。
echo [NOTICE] 作業が完了し終了する場合は、この画面で「Enter」キーを
echo          押してください。
echo          ※ すべての会話履歴とデータは安全に自動保存されています。
echo ============================================================

pause >nul

echo.
echo ------------------------------------------------------------
echo [INFO] GeoRhizome AI をシャットダウンしています...
echo [INFO] コンテナと推論モデルを安全にアンロード中...
docker compose down
echo [SUCCESS] システムのシャットダウンとメモリ解放が完了しました。
timeout /t 3 >nul
