import os

filepath = 'installers/install.ps1'
with open(filepath, 'r', encoding='utf-16') as f:
    content = f.read()

content = content.replace('start http://localhost:3000', 'start http://localhost:3001')

with open(filepath, 'w', encoding='utf-16') as f:
    f.write(content)

sh_filepath = 'installers/install.sh'
with open(sh_filepath, 'r', encoding='utf-8') as f:
    sh_content = f.read()

sh_content = sh_content.replace('http://localhost:3000', 'http://localhost:3001')

with open(sh_filepath, 'w', encoding='utf-8') as f:
    f.write(sh_content)
