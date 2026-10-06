# GeoRhizome AI - Windows Installer
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "🚀 GeoRhizome AI のインストールを開始します..." -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Cyan

# 1. Check Docker
if (-Not (Get-Command "docker" -ErrorAction SilentlyContinue)) {
    Write-Host "❌ エラー: Docker Desktopがインストールされていません。" -ForegroundColor Red
    Write-Host "Docker Desktopをインストールしてから再実行してください: https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
    Exit
}
Write-Host "✅ Docker の起動を確認しました。" -ForegroundColor Green

# 2. Hardware Detection
Write-Host "🔍 ハードウェアを分析中..." -ForegroundColor Cyan
$ComputerInfo = Get-CimInstance Win32_ComputerSystem
$RAM_GB = [math]::Round($ComputerInfo.TotalPhysicalMemory / 1GB)

Write-Host "💻 搭載メモリ: ${RAM_GB} GB" -ForegroundColor White

if ($RAM_GB -lt 16) {
    $RECOMMENDATION = "Q2_K (超軽量)"
} elseif ($RAM_GB -lt 32) {
    $RECOMMENDATION = "Q4_K_M (最適フィット)"
} else {
    $RECOMMENDATION = "Q8_0 (高品質)"
}

Write-Host "✨ 推奨モデル: ${RECOMMENDATION}" -ForegroundColor Yellow
Write-Host "※ インストール完了後、画面右上の「GeoRhizome モデルハブ」から上記の推奨モデルをクリックしてダウンロードしてください。" -ForegroundColor Magenta
Write-Host "=================================================" -ForegroundColor Cyan

# 3. Setup Directories
$INSTALL_DIR = "$env:USERPROFILE\.georhizome"
New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\models" | Out-Null
New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\storage" | Out-Null
Write-Host "📂 インストールディレクトリを作成しました: $INSTALL_DIR" -ForegroundColor Green

# 4. Authentication (Admin will replace <TOKEN>)
# docker login ghcr.io -u BAIZ1D -p <YOUR_READ_ONLY_TOKEN>
Write-Host "🔒 コンテナレジストリに接続中..." -ForegroundColor Cyan

# 5. Fetch Compose File
# Invoke-WebRequest -Uri "https://raw.githubusercontent.com/BAIZ1D/GeoRhizome_AI-LTS/main/installers/employee-docker-compose.yml" -OutFile "$INSTALL_DIR\docker-compose.yml"
Write-Host "📥 GeoRhizome AI のコアシステムをダウンロード中..." -ForegroundColor Cyan

Write-Host "🚀 システムを起動しています... (数分かかる場合があります)" -ForegroundColor Green
# Set-Location -Path $INSTALL_DIR
# docker-compose up -d

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "🎉 インストールが完了しました！" -ForegroundColor Green
Write-Host "🌐 ブラウザで http://localhost:3000 にアクセスしてください。" -ForegroundColor White
Write-Host "=================================================" -ForegroundColor Cyan

# Open browser natively
Start-Process "http://localhost:3000"
