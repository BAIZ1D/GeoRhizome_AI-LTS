import os

filepath = 'installers/install.ps1'
with open(filepath, 'r', encoding='utf-16') as f:
    content = f.read()

# 1. Replace Set-Content to avoid BOM in .bat files
content = content.replace(
    'Set-Content -Path "$INSTALL_DIR\\docker-compose.yml" -Value $ComposeContent -Encoding UTF8',
    '[System.IO.File]::WriteAllText("$INSTALL_DIR\\docker-compose.yml", $ComposeContent, [System.Text.UTF8Encoding]::new($false))'
)
content = content.replace(
    'Set-Content -Path "$INSTALL_DIR\\start_georhizome.bat" -Value $BatContent -Encoding UTF8',
    '[System.IO.File]::WriteAllText("$INSTALL_DIR\\start_georhizome.bat", $BatContent, [System.Text.UTF8Encoding]::new($false))'
)
content = content.replace(
    'Set-Content -Path "$INSTALL_DIR\\update_georhizome.bat" -Value $UpdateBatContent -Encoding UTF8',
    '[System.IO.File]::WriteAllText("$INSTALL_DIR\\update_georhizome.bat", $UpdateBatContent, [System.Text.UTF8Encoding]::new($false))'
)

# 2. Add pause to the end of the script so it doesn't instantly close
if "Read-Host" not in content and "ReadKey" not in content:
    content += '\n\nWrite-Host "Press any key to exit..." -ForegroundColor Cyan\n$null = $Host.UI.RawUI.ReadKey(\'NoEcho,IncludeKeyDown\')\n'

with open(filepath, 'w', encoding='utf-16') as f:
    f.write(content)
