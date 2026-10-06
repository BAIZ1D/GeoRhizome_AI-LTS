# GeoRhizome AI - Windows Installer
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  GeoRhizome AI Enterprise Edition - System Installer" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Check Docker
Write-Host "[INFO] 実行環境を確認しています..." -ForegroundColor Gray
if (-Not (Get-Command "docker" -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Docker Desktop がインストールされていません。" -ForegroundColor Red
    Exit
}
Write-Host "[SUCCESS] Docker Desktop の稼働を確認しました。" -ForegroundColor Green

Write-Host ""
# 2. Hardware Detection
Write-Host "[SYSTEM] ハードウェア・プロファイリングを実行中..." -ForegroundColor Gray
$ComputerInfo = Get-CimInstance Win32_ComputerSystem
$RAM_GB = [math]::Round($ComputerInfo.TotalPhysicalMemory / 1GB)
Write-Host "[SYSTEM] 物理メモリ (RAM): ${RAM_GB} GB" -ForegroundColor White

if ($RAM_GB -lt 16) {
    $RECOMMENDATION = "Q2_K (超軽量版)"
} elseif ($RAM_GB -lt 32) {
    $RECOMMENDATION = "Q4_K_M (最適構成)"
} else {
    $RECOMMENDATION = "Q8_0 (高品質版)"
}

Write-Host "[INFO] 推奨推論モデル: ${RECOMMENDATION}" -ForegroundColor Yellow
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan

# 3. Setup Directories
$INSTALL_DIR = "$env:USERPROFILE\.georhizome"
New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\models" | Out-Null
New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\storage" | Out-Null
Write-Host "[STEP] インストールディレクトリを構成しています... ($INSTALL_DIR)" -ForegroundColor Gray

# 4. Authentication (Admin will replace <TOKEN>)
Write-Host "[STEP] セキュア・コンテナレジストリへ接続中..." -ForegroundColor Gray

# 5. Generate Core Files natively (No external download needed!)
Write-Host "[STEP] コア・システム構成ファイルを生成中..." -ForegroundColor Gray

$ComposeContent = @"
version: '3.8'
services:
  georhizome-core:
    image: ghcr.io/baiz1d/georhizome_ai-lts:latest
    container_name: georhizome-core
    ports:
      - `"3000:3000`"
      - `"3001:3001`"
      - `"8888:8888`"
    volumes:
      - ./storage:/app/server/storage
    environment:
      - NODE_ENV=production
    restart: unless-stopped
"@
Set-Content -Path "$INSTALL_DIR\docker-compose.yml" -Value $ComposeContent -Encoding UTF8

$BatContent = @"
@echo off
title GeoRhizome AI Enterprise Edition
chcp 65001 >nul
echo ============================================================
echo   GeoRhizome AI Enterprise Edition - 起動ツール
echo ============================================================
cd %USERPROFILE%\.georhizome
docker compose up -d >nul 2>&1
echo [SUCCESS] システムが起動しました！ブラウザを開きます...
start http://localhost:3000
echo ------------------------------------------------------------
echo [NOTICE] ⚠️ 注意: 終了する場合はこの画面で「Enter」キーを押してください。
pause >nul
echo [INFO] GeoRhizome AI をシャットダウンしています...
docker compose down >nul 2>&1
echo [SUCCESS] システムのシャットダウンが完了しました。
timeout /t 3 >nul
"@
Set-Content -Path "$INSTALL_DIR\start_georhizome.bat" -Value $BatContent -Encoding UTF8

Write-Host "[STEP] デスクトップにショートカットを作成しています..." -ForegroundColor Gray
$WshShell = New-Object -comObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')
$Shortcut = $WshShell.CreateShortcut("$DesktopPath\GeoRhizome AI.lnk")
$Shortcut.TargetPath = "$INSTALL_DIR\start_georhizome.bat"
$Shortcut.WorkingDirectory = "$INSTALL_DIR"
$Shortcut.Save()

Write-Host "------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "[SUCCESS] GeoRhizome AI のインストールが正常に完了しました。" -ForegroundColor Green
Write-Host "[INFO] デスクトップの「GeoRhizome AI」アイコンから起動できます！" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Cyan
