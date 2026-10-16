# GeoRhizome AI - Windows Installer
$Code = @"
using System;
using System.Runtime.InteropServices;
public class ConsoleFont {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CONSOLE_FONT_INFO_EX {
        public uint cbSize;
        public uint nFont;
        public short dwFontSizeX;
        public short dwFontSizeY;
        public int FontFamily;
        public int FontWeight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string FaceName;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetCurrentConsoleFontEx(IntPtr hConsoleOutput, bool bMaximumWindow, ref CONSOLE_FONT_INFO_EX lpConsoleCurrentFontEx);
    public static void SetFont(string fontName) {
        CONSOLE_FONT_INFO_EX info = new CONSOLE_FONT_INFO_EX();
        info.cbSize = (uint)Marshal.SizeOf(info);
        info.FaceName = fontName;
        SetCurrentConsoleFontEx(GetStdHandle(-11), false, ref info);
    }
}
"@
try {
    Add-Type -TypeDefinition $Code -ErrorAction SilentlyContinue
    [ConsoleFont]::SetFont("MS Gothic")
} catch {}

# Default models (LLM, embedder, reranker) come from config\app_config.json via
# installers\georhizome_setup.py; nothing model-specific is hardcoded here.
$ErrorActionPreference = "Stop"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Fail([string]$Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    Write-Host "Press any key to exit..." -ForegroundColor Cyan
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}

# Run a native command and stop with a visible error when it exits non-zero.
function Invoke-Native([string]$Step, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Fail "$Step (exit code $LASTEXITCODE)" }
}

function Get-Source([string]$Destination) {
    $Zip = "$INSTALL_DIR\repo.zip"
    $Tmp = "$INSTALL_DIR\temp_extract"
    try {
        Invoke-RestMethod -Uri "https://api.github.com/repos/BAIZ1D/GeoRhizome_AI-LTS/zipball/main" -OutFile $Zip
        if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
        Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
        $Extracted = Get-ChildItem $Tmp | Select-Object -First 1
        Copy-Item -Path "$($Extracted.FullName)\*" -Destination $Destination -Recurse -Force
    } catch {
        Fail "ソースコードのダウンロードに失敗しました: $($_.Exception.Message)"
    } finally {
        if (Test-Path $Zip) { Remove-Item $Zip -Force }
        if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
    }
}

# Copy a .bat from the source tree with CRLF line endings (cmd.exe labels need CRLF).
function Copy-Bat([string]$From, [string]$To) {
    $Text = [System.IO.File]::ReadAllText($From) -replace "`r?`n", "`r`n"
    [System.IO.File]::WriteAllText($To, $Text, $Utf8NoBom)
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  GeoRhizome AI Enterprise Edition - System Installer" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Check Docker
Write-Host "[INFO] 実行環境を確認しています..." -ForegroundColor Gray
if (-Not (Get-Command "docker" -ErrorAction SilentlyContinue)) {
    Fail "Docker Desktop がインストールされていません。https://www.docker.com/products/docker-desktop/"
}
Invoke-Native "Docker Desktop が起動していません" { docker info --format "{{.ServerVersion}}" }
Write-Host "[SUCCESS] Docker Desktop の稼働を確認しました。" -ForegroundColor Green

# 2. Hardware Detection
Write-Host ""
Write-Host "[SYSTEM] ハードウェア・プロファイリングを実行中..." -ForegroundColor Gray
$ComputerInfo = Get-CimInstance Win32_ComputerSystem
$RAM_GB = [math]::Round($ComputerInfo.TotalPhysicalMemory / 1GB)
Write-Host "[SYSTEM] 物理メモリ (RAM): ${RAM_GB} GB" -ForegroundColor White
Write-Host "[NOTICE] 既定モデルは自動でダウンロードされます。変更は「GeoRhizome モデルハブ」から行えます。" -ForegroundColor Yellow
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan

# 3. Setup Directories
$INSTALL_DIR = "$env:USERPROFILE\.georhizome"
$SourceDir = "$INSTALL_DIR\source"
$ModelsDir = "$INSTALL_DIR\storage\models"
foreach ($d in @($INSTALL_DIR, "$INSTALL_DIR\storage", $ModelsDir, $SourceDir, "$INSTALL_DIR\logs")) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Write-Host "[STEP] インストールディレクトリを構成しています... ($INSTALL_DIR)" -ForegroundColor Gray

# 4. The GHCR image and GitHub repo are public: no token or registry login needed.

# 5. Download the source (services, config, installers)
Write-Host "[STEP] ソースコードをダウンロードしています..." -ForegroundColor Gray
Get-Source $SourceDir
if (Test-Path "$SourceDir\models") { Remove-Item "$SourceDir\models" -Recurse -Force }
New-Item -ItemType Junction -Path "$SourceDir\models" -Target $ModelsDir | Out-Null

# 6. Compose file (model preferences live in server\.env, which the Model Hub updates)
$ComposeContent = @'
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
'@
[System.IO.File]::WriteAllText("$INSTALL_DIR\docker-compose.yml", $ComposeContent, $Utf8NoBom)

# 7. Python runtime (torch==2.5.1 ships wheels for Python 3.10-3.12 only)
Write-Host "[STEP] AI推論エンジンのネイティブ環境を構築中 (Python / CUDA)..." -ForegroundColor Cyan
$PyExe = $null
$PyArgs = @()
$VersionCheck = "import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 13) else 1)"
if (Get-Command "py" -ErrorAction SilentlyContinue) {
    foreach ($v in @("-3.12", "-3.11", "-3.10")) {
        & py $v -c $VersionCheck
        if ($LASTEXITCODE -eq 0) { $PyExe = "py"; $PyArgs = @($v); break }
    }
}
if (-not $PyExe -and (Get-Command "python" -ErrorAction SilentlyContinue)) {
    & python -c $VersionCheck
    if ($LASTEXITCODE -eq 0) { $PyExe = "python" }
}
if (-not $PyExe) {
    Fail "Python 3.10〜3.12 が見つかりません (Python 3.10 以上が必要、torch 2.5.1 は 3.13 以降未対応)。python.org から 3.12 をインストールしてください。"
}

Set-Location $SourceDir
$VenvPy = "$SourceDir\.venv\Scripts\python.exe"
if (Test-Path $VenvPy) {
    & $VenvPy -c $VersionCheck
    if ($LASTEXITCODE -ne 0) { Remove-Item "$SourceDir\.venv" -Recurse -Force }
}
Invoke-Native "venv の作成に失敗しました" { & $PyExe @PyArgs -m venv .venv }

Write-Host "   依存パッケージをインストールしています (数分かかる場合があります)..." -ForegroundColor Yellow
Invoke-Native "pip の更新に失敗しました" { & $VenvPy -m pip install --upgrade pip }
Invoke-Native "torch のインストールに失敗しました" { & $VenvPy -m pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu121 }
Invoke-Native "llama-cpp-python のインストールに失敗しました" { & $VenvPy -m pip install "llama-cpp-python[server]==0.3.4" --only-binary llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121 }
Invoke-Native "依存パッケージのインストールに失敗しました" { & $VenvPy -m pip install "transformers==5.18.0" "sentence-transformers==6.1.0" "huggingface_hub>=1.31,<2" fastapi uvicorn psutil pyyaml requests }
Write-Host "   ネイティブAI環境の構築が完了しました。" -ForegroundColor Green

# 8. server\.env (created if missing, UTF-8 without BOM) + legacy-default migration on re-install
$Helper = "$SourceDir\installers\georhizome_setup.py"
$ServerEnv = "$SourceDir\georhizome-ai-source\server\.env"
Invoke-Native "server\.env の生成に失敗しました" { & $VenvPy $Helper write-env --env $ServerEnv }
Invoke-Native "設定の移行に失敗しました" { & $VenvPy $Helper migrate --env $ServerEnv }

# 9. Default models: LLM GGUF -> storage\models, embedder + reranker -> default HF cache
Write-Host "[STEP] デフォルトのAIモデルをダウンロードしています (初期化用)..." -ForegroundColor Gray
Invoke-Native "モデルのダウンロードに失敗しました" { & $VenvPy "$SourceDir\installers\georhizome_setup.py" download --models-dir $ModelsDir }

# 10. Launcher + OTA updater
Copy-Bat "$SourceDir\installers\start_georhizome.bat" "$INSTALL_DIR\start_georhizome.bat"

$UpdatePs1 = @'
$ErrorActionPreference = "Stop"
$GR = "$env:USERPROFILE\.georhizome"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
function Check([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit code $LASTEXITCODE)" } }
try {
    Write-Host "[INFO] GeoRhizome AI のアップデートを確認しています..."
    Set-Location $GR
    docker compose pull; Check "docker compose pull"
    Write-Host "[INFO] ネイティブAIエンジンのアップデートを確認しています..."
    $Zip = "$GR\repo.zip"; $Tmp = "$GR\temp_extract"
    Invoke-RestMethod -Uri "https://api.github.com/repos/BAIZ1D/GeoRhizome_AI-LTS/zipball/main" -OutFile $Zip
    if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
    Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
    $Extracted = Get-ChildItem $Tmp | Select-Object -First 1
    Copy-Item -Path "$($Extracted.FullName)\*" -Destination "$GR\source" -Recurse -Force
    Remove-Item $Zip -Force; Remove-Item $Tmp -Recurse -Force
    $Bat = [System.IO.File]::ReadAllText("$GR\source\installers\start_georhizome.bat") -replace "`r?`n", "`r`n"
    [System.IO.File]::WriteAllText("$GR\start_georhizome.bat", $Bat, $Utf8NoBom)
    & "$GR\source\.venv\Scripts\python.exe" "$GR\source\installers\georhizome_setup.py" migrate --env "$GR\source\georhizome-ai-source\server\.env"; Check "migrate"
    Write-Host "[SUCCESS] アップデートが完了しました！ GeoRhizome AI を一度閉じて、再度起動してください。" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] アップデートに失敗しました: $($_.Exception.Message)" -ForegroundColor Red
}
'@
[System.IO.File]::WriteAllText("$INSTALL_DIR\update_georhizome.ps1", $UpdatePs1, [System.Text.UTF8Encoding]::new($true))
$UpdateBat = "@echo off`r`nchcp 65001 >nul`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0update_georhizome.ps1`"`r`npause`r`n"
[System.IO.File]::WriteAllText("$INSTALL_DIR\update_georhizome.bat", $UpdateBat, $Utf8NoBom)

# 11. Desktop shortcuts
Write-Host "[STEP] デスクトップにショートカットを作成しています..." -ForegroundColor Gray
$WshShell = New-Object -comObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')
$Shortcut = $WshShell.CreateShortcut("$DesktopPath\GeoRhizome AI.lnk")
$Shortcut.TargetPath = "$INSTALL_DIR\start_georhizome.bat"
$Shortcut.WorkingDirectory = "$INSTALL_DIR"
$Shortcut.Save()
$UpdateShortcut = $WshShell.CreateShortcut("$DesktopPath\Update GeoRhizome AI.lnk")
$UpdateShortcut.TargetPath = "$INSTALL_DIR\update_georhizome.bat"
$UpdateShortcut.WorkingDirectory = "$INSTALL_DIR"
$UpdateShortcut.Save()

# 12. Container image
Write-Host "[STEP] クラスタの初期化とコンテナのダウンロードを開始します..." -ForegroundColor Gray
Set-Location $INSTALL_DIR
Invoke-Native "docker compose pull に失敗しました" { docker compose pull }

Write-Host "------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "[SUCCESS] GeoRhizome AI のインストールが正常に完了しました。" -ForegroundColor Green
Write-Host "[INFO] デスクトップの「GeoRhizome AI」アイコンから起動できます！" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Press any key to exit..." -ForegroundColor Cyan
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
