import os

filepath = 'georhizome-ai-source/frontend/src/pages/OnboardingFlow/Steps/UserSetup/index.jsx'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Make handleForward async and update navigation
content = content.replace('function handleForward() {', 'async function handleForward() {')
content = content.replace('navigate(paths.onboarding.dataHandling());', 'await System.markOnboardingComplete();\\n      navigate(paths.home());')

# Fix MyTeam navigation order
content = content.replace('''    await System.markOnboardingComplete();
      navigate(paths.home());
    // Auto-request token with credentials that was just set so they
    // are not redirected to login after completion.
    const { user, token } = await System.requestToken(data);
    window.localStorage.setItem(AUTH_USER, JSON.stringify(user));
    window.localStorage.setItem(AUTH_TOKEN, token);
    window.localStorage.removeItem(AUTH_TIMESTAMP);''', '''    // Auto-request token with credentials that was just set so they
    // are not redirected to login after completion.
    const { user, token } = await System.requestToken(data);
    window.localStorage.setItem(AUTH_USER, JSON.stringify(user));
    window.localStorage.setItem(AUTH_TOKEN, token);
    window.localStorage.removeItem(AUTH_TIMESTAMP);
    await System.markOnboardingComplete();
    navigate(paths.home());''')

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
