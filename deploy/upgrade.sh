#!/usr/bin/env bash

set -Eeuo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd)/lib.sh"

target_ref=""
fetch_tags=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-fetch) fetch_tags=false; shift ;;
    --help)
      echo "用法：bash deploy/upgrade.sh [Git 标签或提交] [--no-fetch]"
      exit 0
      ;;
    -*) die "未知参数：$1" ;;
    *) [[ -z "$target_ref" ]] || die "只能指定一个目标版本"; target_ref="$1"; shift ;;
  esac
done

require_command docker
require_command git
load_production_env
ensure_directories
[[ -n "$FRONTEND_ROOT" ]] || die "找不到同级 NPClassworks 前端仓库"
require_clean_repository "$REPO_ROOT" "后端仓库"
require_clean_repository "$FRONTEND_ROOT" "前端仓库"

previous_backend_ref="$(current_ref "$REPO_ROOT")"
previous_frontend_ref="$(current_ref "$FRONTEND_ROOT")"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backend_rollback_tag="npclassworks-backend:rollback-$timestamp"
frontend_rollback_tag="npclassworks-frontend:rollback-$timestamp"
state_file="$RUNTIME_DIR/rollback-state.env"
backup_file="$(bash "$DEPLOY_DIR/backup.sh" --label pre-upgrade)"

docker image inspect npclassworks-backend:current >/dev/null 2>&1 || die "找不到当前后端镜像；请先完成首次生产部署"
docker image inspect npclassworks-frontend:current >/dev/null 2>&1 || die "找不到当前前端镜像；请先完成首次生产部署"
docker tag npclassworks-backend:current "$backend_rollback_tag"
docker tag npclassworks-frontend:current "$frontend_rollback_tag"

: > "$state_file"
write_state_value "$state_file" CREATED_AT "$timestamp"
write_state_value "$state_file" BACKUP_FILE "$backup_file"
write_state_value "$state_file" PREVIOUS_BACKEND_REF "$previous_backend_ref"
write_state_value "$state_file" PREVIOUS_FRONTEND_REF "$previous_frontend_ref"
write_state_value "$state_file" BACKEND_ROLLBACK_TAG "$backend_rollback_tag"
write_state_value "$state_file" FRONTEND_ROLLBACK_TAG "$frontend_rollback_tag"
chmod 600 "$state_file" 2>/dev/null || true

if [[ -n "$target_ref" ]]; then
  if [[ "$fetch_tags" == true ]]; then
    git -C "$REPO_ROOT" fetch --tags --prune
    git -C "$FRONTEND_ROOT" fetch --tags --prune
  fi
  git -C "$REPO_ROOT" rev-parse --verify "$target_ref^{commit}" >/dev/null || die "后端仓库不存在版本：$target_ref"
  git -C "$FRONTEND_ROOT" rev-parse --verify "$target_ref^{commit}" >/dev/null || die "前端仓库不存在版本：$target_ref"
  git -C "$REPO_ROOT" checkout --detach "$target_ref"
  git -C "$FRONTEND_ROOT" checkout --detach "$target_ref"
fi

log "构建并启动新版本"
node "$REPO_ROOT/scripts/check-production-env.js" "$ENV_FILE"
compose build --pull backend frontend
compose_application_up -d
if ! wait_for_backend 45; then
  die "升级后端未能就绪。可运行：bash deploy/rollback.sh"
fi

log "升级完成。升级前备份：$backup_file"
log "如需回滚应用：bash deploy/rollback.sh"
log "如需连数据库回滚：bash deploy/rollback.sh --restore-database --yes"
