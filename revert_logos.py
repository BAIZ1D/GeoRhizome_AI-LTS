import os
import glob

# Revert LogoContext
filepath = 'georhizome-ai-source/frontend/src/LogoContext.jsx'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('import GeoRhizomeAILogo from "./media/illustrations/login-logo-light.svg";', 'import GeoRhizomeAILogo from "./media/logo/anything-llm.png";')
content = content.replace('import AnythingLLMDark from "./media/illustrations/login-logo.svg";', 'import AnythingLLMDark from "./media/logo/anything-llm-dark.png";')
content = content.replace('import DefaultLoginLogoLight from "./media/illustrations/login-logo.svg";', 'import DefaultLoginLogoLight from "./media/logo/anything-llm-dark.png";')
content = content.replace('import DefaultLoginLogoDark from "./media/illustrations/login-logo-light.svg";', 'import DefaultLoginLogoDark from "./media/logo/anything-llm.png";')

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

# Revert other JSX files (EXCEPT OnboardingLogoSVG.jsx)
def revert_logos(pattern):
    for p in glob.glob(pattern, recursive=True):
        if 'OnboardingLogoSVG.jsx' in p:
            continue
        try:
            with open(p, 'r', encoding='utf-8') as f:
                c = f.read()
            
            # The previous script replaced:
            # @/media/logo/anything-llm-icon.png -> @/media/illustrations/login-logo.svg
            # @/media/logo/anything-llm-infinity.png -> @/media/illustrations/login-logo.svg
            # @/media/logo/anything-llm.png -> @/media/illustrations/login-logo-light.svg
            # @/media/logo/anything-llm-dark.png -> @/media/illustrations/login-logo.svg
            
            # We can just revert it by looking for the specific variable name usages in the imports.
            # E.g. import AnythingLLMIcon from "@/media/illustrations/login-logo.svg";
            c = c.replace('import AnythingLLMIcon from "@/media/illustrations/login-logo.svg";', 'import AnythingLLMIcon from "@/media/logo/anything-llm-icon.png";')
            c = c.replace('import AnythingInfinityLogo from "@/media/illustrations/login-logo.svg";', 'import AnythingInfinityLogo from "@/media/logo/anything-llm-infinity.png";')
            c = c.replace('import Logo from "@/media/illustrations/login-logo.svg";', 'import Logo from "@/media/logo/anything-llm-icon.png";')
            c = c.replace('@/media/illustrations/login-logo.svg', '@/media/logo/anything-llm-icon.png')
            c = c.replace('@/media/illustrations/login-logo-light.svg', '@/media/logo/anything-llm.png')
            
            with open(p, 'w', encoding='utf-8') as f:
                f.write(c)
        except Exception as e:
            pass

revert_logos('georhizome-ai-source/frontend/src/**/*.jsx')
