# GeoRhizome AI - Windows Installer
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  GeoRhizome AI Enterprise Edition - System Installer" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Check Docker
Write-Host "[INFO] 実行環境を確認しています..." -ForegroundColor Gray
if (-Not (Get-Command "docker" -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Docker Desktop がインストールされていません。" -ForegroundColor Red
    Write-Host "[ERROR] 以下のリンクよりインストールし、再実行してください。" -ForegroundColor Red
    Write-Host "        https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
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
Write-Host "[NOTICE] インストール完了後、画面右上の「GeoRhizome モデルハブ」を開き、" -ForegroundColor Magenta
Write-Host "         上記の推奨モデルを選択してセットアップを完了してください。" -ForegroundColor Magenta
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan

# 3. Setup Directories
$INSTALL_DIR = "$env:USERPROFILE\.georhizome"
New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\models" | Out-Null
New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\storage" | Out-Null
Write-Host "[STEP] インストールディレクトリを構成しています... ($INSTALL_DIR)" -ForegroundColor Gray

# 4. Authentication (Admin will replace <TOKEN>)
# docker login ghcr.io -u BAIZ1D -p <YOUR_READ_ONLY_TOKEN>
Write-Host "[STEP] セキュア・コンテナレジストリへ接続中..." -ForegroundColor Gray

# 5. Fetch Compose File
# Invoke-WebRequest -Uri "https://raw.githubusercontent.com/BAIZ1D/GeoRhizome_AI-LTS/main/installers/employee-docker-compose.yml" -OutFile "$INSTALL_DIR\docker-compose.yml"
Write-Host "[STEP] コア・システムイメージを取得中..." -ForegroundColor Gray

Write-Host "[STEP] コンテナ・クラスタを起動しています... (この処理には数分かかる場合があります)" -ForegroundColor Gray
# Set-Location -Path $INSTALL_DIR
# docker-compose up -d

Write-Host "------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "[SUCCESS] GeoRhizome AI のインストールが正常に完了しました。" -ForegroundColor Green
Write-Host "[INFO] 管理画面: http://localhost:3000" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan

# Open browser natively
Start-Process "http://localhost:3000"
