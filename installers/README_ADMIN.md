# Administrator Guide: Distributing the Installers

The GeoRhizome AI repository and its Docker image (`ghcr.io/baiz1d/georhizome_ai-lts:latest`) are **public**. The installers need no token, no `docker login` and no editing before distribution.

### Distribute
Share `installers/install.sh` (macOS/Linux) and `installers/install.ps1` (Windows) as they are: by email, intranet or USB drive. Each installer pulls the public image anonymously and downloads the default models (`Qwen2.5-1.5B-Instruct-Q3_K_M.gguf`, `cl-nagoya/ruri-v3-310m`, `cl-nagoya/ruri-v3-reranker-310m`).

### Troubleshooting: `denied` when pulling the image
A stale GHCR credential on the machine makes Docker send a revoked token instead of pulling anonymously. Remove it and retry:

```
docker logout ghcr.io
```

On macOS with Docker Desktop the credential lives in the keychain (`credsStore: desktop`), so editing `~/.docker/config.json` alone is not enough.
