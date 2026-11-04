#!/usr/bin/env bash
# Purge ALL vector data: LanceDB dirs (dense + sparse tables), vector-cache, and
# Prisma document_vectors rows. macOS/Linux only (Windows parity out of scope).
#
# Usage: purge_all_vector_stores.sh [--dry-run] [--root DIR] [--port N]
#                                   [--skip-port-check] [--db PATH]
set -euo pipefail

DRY_RUN=0
SKIP_PORT=0
ROOT=""
PORT=""
DB=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-port-check) SKIP_PORT=1 ;;
    --root) ROOT="${2:-}"; shift ;;
    --port) PORT="${2:-}"; shift ;;
    --db) DB="${2:-}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done

if [ -z "$ROOT" ]; then
  ROOT="$(builtin cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
ROOT="$(builtin cd "$ROOT" && pwd)"
SRC_DIR="$ROOT/georhizome-ai-source"
CONFIG="$ROOT/config/app_config.json"
ENV_FILE="$SRC_DIR/server/.env"

# Port: --port > SERVER_PORT in server/.env > env SERVER_PORT > 3001 (documented fallback)
if [ -z "$PORT" ] && [ -f "$ENV_FILE" ]; then
  PORT="$(sed -n 's/^SERVER_PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d '"'"'"' \r')"
fi
PORT="${PORT:-${SERVER_PORT:-3001}}"

STORAGE="${STORAGE_DIR:-}"

fail() { echo "ERROR: $1" >&2; exit "${2:-2}"; }

cfg_get() {
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1])).get("paths",{})
v=d.get(sys.argv[2],"")
print(v if isinstance(v,str) else "")' "$CONFIG" "$1"
}

[ -f "$CONFIG" ] || fail "missing config: $CONFIG"

guard_rel() {
  case "$1" in
    "" | /* | *..*) fail "refusing unsafe config path: '$1'" ;;
  esac
  case "$1" in
    *[!/.]*) ;;
    *) fail "refusing unsafe config path: '$1'" ;;
  esac
}

if [ -n "$STORAGE" ]; then
  LANCE_DIR="$STORAGE/lancedb"
  CACHE_DIR="$STORAGE/vector-cache"
  : "${DB:=$STORAGE/anythingllm.db}"
else
  LANCE_REL="$(cfg_get lancedb_dir)"
  CACHE_REL="$(cfg_get vector_cache_dir)"
  [ -n "$LANCE_REL" ] || fail "paths.lancedb_dir empty in app_config.json"
  [ -n "$CACHE_REL" ] || fail "paths.vector_cache_dir empty in app_config.json"
  guard_rel "$LANCE_REL"
  guard_rel "$CACHE_REL"
  LANCE_DIR="$SRC_DIR/$LANCE_REL"
  CACHE_DIR="$SRC_DIR/$CACHE_REL"
  : "${DB:=$SRC_DIR/server/storage/anythingllm.db}"
fi

guard() {
  local p="$1"
  case "$p" in
    "" | "/" | "$HOME" | "$HOME/") fail "refusing unsafe path: '$p'" ;;
    *..*) fail "refusing path containing '..': '$p'" ;;
  esac
  case "$p" in
    "$ROOT"/?*) return 0 ;;
  esac
  if [ -n "$STORAGE" ]; then
    case "$p" in "$STORAGE"/?*) return 0 ;; esac
  fi
  fail "path outside root/STORAGE_DIR: '$p'"
}

guard "$LANCE_DIR"
guard "$CACHE_DIR"

if [ "$SKIP_PORT" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  if [ -n "$(lsof -ti:"$PORT" 2>/dev/null || true)" ]; then
    fail "app port $PORT is listening; stop the app first (or --skip-port-check)" 3
  fi
fi

WARN_JA="ベクトルデータを削除しました。ワークスペースの文書は再登録（再アップロード）するか、ワークスペースのベクトルDBリセットを実行してください。"
WARN_EN="Vector data removed. Workspace documents still show as embedded: re-upload documents or run each workspace's vector reset."

if [ "$DRY_RUN" -eq 1 ]; then
  echo "would remove: $LANCE_DIR"
  echo "would remove: $CACHE_DIR"
  echo "would clear table: document_vectors (db: $DB)"
  echo "$WARN_JA"
  echo "$WARN_EN"
  echo "Sparse data lives in the LanceDB tables, so it is removed with them."
  exit 0
fi

for d in "$LANCE_DIR" "$CACHE_DIR"; do
  if [ -d "$d" ]; then
    /usr/bin/find "$d" -mindepth 1 -delete
  fi
  mkdir -p "$d"
  echo "removed: $d"
done

if [ -f "$DB" ]; then
  sqlite3 "$DB" "DELETE FROM document_vectors;"
  echo "cleared table: document_vectors"
else
  echo "notice: no sqlite db at $DB; skipped document_vectors"
fi

echo "$WARN_JA"
echo "$WARN_EN"
echo "Sparse data lives in the LanceDB tables, so it is removed with them."
