#!/usr/bin/env bash

set -Eeuo pipefail

DEPLOY_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
FRONTEND_ROOT="$(cd "$REPO_ROOT/../NPClassworks" 2>/dev/null && pwd || true)"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
RUNTIME_DIR="${RUNTIME_DIR:-$DEPLOY_DIR/runtime}"

log() {
  printf '[NPClassworks] %s\n' "$*" >&2
}

die() {
  log "错误：$*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

load_production_env() {
  [[ -f "$ENV_FILE" ]] || die "找不到生产配置：$ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  POSTGRES_USER="${POSTGRES_USER:-classworks}"
  POSTGRES_DB="${POSTGRES_DB:-classworks}"
  BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
  [[ -n "${POSTGRES_PASSWORD:-}" ]] || die "POSTGRES_PASSWORD 未配置"
}

compose() {
  docker compose --project-directory "$REPO_ROOT" --env-file "$ENV_FILE" -f "$REPO_ROOT/docker-compose.yml" "$@"
}

ensure_directories() {
  mkdir -p "$BACKUP_DIR" "$RUNTIME_DIR"
  BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
  RUNTIME_DIR="$(cd "$RUNTIME_DIR" && pwd)"
  chmod 700 "$BACKUP_DIR" "$RUNTIME_DIR" 2>/dev/null || true
}

current_ref() {
  git -C "$1" rev-parse HEAD 2>/dev/null || printf 'unknown'
}

require_clean_repository() {
  local repository="$1"
  local label="$2"
  [[ -d "$repository/.git" ]] || die "$label 不是 Git 仓库：$repository"
  [[ -z "$(git -C "$repository" status --porcelain)" ]] || die "$label 存在未提交修改，拒绝升级或切换版本"
}

write_state_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  printf '%s=%q\n' "$key" "$value" >> "$file"
}

wait_for_backend() {
  local attempts="${1:-30}"
  local count=1
  while (( count <= attempts )); do
    if compose exec -T backend node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    ((count++))
  done
  return 1
}
