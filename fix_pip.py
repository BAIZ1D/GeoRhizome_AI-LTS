import os

def fix_ps1(filepath):
    with open(filepath, 'r', encoding='utf-16') as f:
        content = f.read()

    # The pip command
    old_cmd = '".venv\\Scripts\\python.exe -m pip install "llama-cpp-python[server]" fastapi uvicorn sentence-transformers psutil pyyaml requests huggingface_hub | Out-Null"'
    new_cmd = '".venv\\Scripts\\python.exe -m pip install "llama-cpp-python[server]" --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121 fastapi uvicorn sentence-transformers psutil pyyaml requests huggingface_hub | Out-Null"'
    
    # Actually wait, let's just do a simple replace on the exact substring
    content = content.replace('pip install "llama-cpp-python[server]" fastapi', 'pip install "llama-cpp-python[server]" --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121 fastapi')

    with open(filepath, 'w', encoding='utf-16') as f:
        f.write(content)

def fix_sh(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    content = content.replace('pip install "llama-cpp-python[server]" fastapi', 'pip install "llama-cpp-python[server]" --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121 fastapi')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

fix_ps1('installers/install.ps1')
fix_sh('installers/install.sh')
print("Fixed pip install command!")
