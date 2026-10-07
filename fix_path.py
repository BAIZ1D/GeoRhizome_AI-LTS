import os
filepath = 'installers/install.ps1'
with open(filepath, 'r', encoding='utf-8-sig') as f:
    content = f.read()

content = content.replace('Copy-Item -Path "$ExtractedFolder\\*"', 'Copy-Item -Path "$($ExtractedFolder.FullName)\\*"')

with open(filepath, 'w', encoding='utf-8-sig') as f:
    f.write(content)
