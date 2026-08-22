#!/usr/bin/env bash

set -Eeuo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd)/lib.sh"

label="manual"
retention_days=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) label="${2:-}"; shift 2 ;;
    --retention-days) retention_days="${2:-}"; shift 2 ;;
    --help)
      echo "用法：bash deploy/backup.sh [--label 名称] [--retention-days 天数]"
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

require_command docker
require_command sha256sum
load_production_env
ensure_directories

retention_days="${retention_days:-$BACKUP_RETENTION_DAYS}"
[[ "$retention_days" =~ ^[0-9]+$ ]] || die "保留天数必须是非负整数"
safe_label="$(printf '%s' "$label" | tr -cs 'A-Za-z0-9._-' '_' | sed 's/^_*//;s/_*$//')"
[[ -n "$safe_label" ]] || safe_label="manual"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="npclassworks_${POSTGRES_DB}_${timestamp}_${safe_label}"
target="$BACKUP_DIR/$base.dump"
temporary="$target.partial"
[[ ! -e "$target" && ! -e "$temporary" ]] || die "同名备份已经存在，请稍后重试"

trap 'rm -f "$temporary"' EXIT
compose ps --status running --services | grep -qx postgres || die "PostgreSQL 容器尚未运行"
log "正在备份 PostgreSQL 数据库 $POSTGRES_DB"
compose exec -T postgres pg_dump \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --format custom \
  --compress 6 \
  --no-owner \
  --no-privileges > "$temporary"

[[ -s "$temporary" ]] || die "备份文件为空"
compose exec -T postgres pg_restore --list < "$temporary" >/dev/null
mv "$temporary" "$target"
(cd "$BACKUP_DIR" && sha256sum "${target##*/}" > "${target##*/}.sha256")
{
  printf 'created_at=%s\n' "$timestamp"
  printf 'database=%s\n' "$POSTGRES_DB"
  printf 'backend_ref=%s\n' "$(current_ref "$REPO_ROOT")"
  printf 'frontend_ref=%s\n' "$(current_ref "$FRONTEND_ROOT")"
  printf 'backend_version=%s\n' "$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || true)"
  printf 'frontend_version=%s\n' "$(node -p "require('$FRONTEND_ROOT/package.json').version" 2>/dev/null || true)"
} > "$target.meta"
chmod 600 "$target" "$target.sha256" "$target.meta" 2>/dev/null || true

if (( retention_days > 0 )); then
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'npclassworks_*.dump' -o -name 'npclassworks_*.dump.sha256' -o -name 'npclassworks_*.dump.meta' \) \
    -mtime "+$retention_days" -delete
fi

log "备份完成：$target"
printf '%s\n' "$target"
