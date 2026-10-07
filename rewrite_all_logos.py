import os
import glob

# Fix LogoContext
filepath = 'georhizome-ai-source/frontend/src/LogoContext.jsx'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('import GeoRhizomeAILogo from "./media/logo/anything-llm.png";', 'import GeoRhizomeAILogo from "./media/illustrations/login-logo-light.svg";')
content = content.replace('import AnythingLLMDark from "./media/logo/anything-llm-dark.png";', 'import AnythingLLMDark from "./media/illustrations/login-logo.svg";')

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

# Replace other anything-llm logos across all JSX files
def replace_logos(pattern):
    for p in glob.glob(pattern, recursive=True):
        try:
            with open(p, 'r', encoding='utf-8') as f:
                c = f.read()
            c = c.replace('@/media/logo/anything-llm-icon.png', '@/media/illustrations/login-logo.svg')
            c = c.replace('@/media/logo/anything-llm-infinity.png', '@/media/illustrations/login-logo.svg')
            c = c.replace('@/media/logo/anything-llm.png', '@/media/illustrations/login-logo-light.svg')
            c = c.replace('@/media/logo/anything-llm-dark.png', '@/media/illustrations/login-logo.svg')
            with open(p, 'w', encoding='utf-8') as f:
                f.write(c)
        except Exception as e:
            pass

replace_logos('georhizome-ai-source/frontend/src/**/*.jsx')
replace_logos('georhizome-ai-source/frontend/src/**/*.js')
