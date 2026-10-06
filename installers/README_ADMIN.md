# Administrator Guide: Securing the Enterprise Installers

Because the GeoRhizome AI repository is **Private**, the Docker images hosted on GitHub Container Registry (GHCR) are also strictly private. Without authentication, an employee's computer will return a "404 Not Found" when trying to install or update the software.

To solve this completely frictionlessly for your employees (so they don't need GitHub accounts), we embedded a silent authentication script into the installers. 

**You must follow these 3 steps before giving the installers to your employees:**

### Step 1: Generate a Read-Only Token
1. Log into your GitHub account and go to **Settings** > **Developer Settings** > **Personal access tokens** > **Tokens (classic)**.
2. Click **Generate new token (classic)**.
3. Name it: `GeoRhizome Employee Distribution`
4. Set Expiration to **No expiration**.
5. Under scopes, check **ONLY** the `read:packages` box. *(Do NOT check `repo`! This ensures that if an employee finds the token, they can only download the app, they cannot see or edit your private source code).*
6. Click **Generate token** and copy the string (it will start with `ghp_`).

### Step 2: Inject the Token into the Installers
Open both `install.sh` and `install.ps1` in a text editor.

Scroll down to **Step 4 (Authentication)**. You will see this line:
`GHCR_READ_TOKEN="REPLACE_ME_BEFORE_DISTRIBUTION"`

Delete `REPLACE_ME_BEFORE_DISTRIBUTION` and paste your actual token inside the quotes:
`GHCR_READ_TOKEN="ghp_XyZ123..."`

### Step 3: Distribute!
Save the scripts. You can now freely email them, put them on a company intranet, or put them on a USB drive. When an employee runs it, their computer will silently use that token to log into Docker, proving they belong to your company, and seamlessly download the private AI cluster!
