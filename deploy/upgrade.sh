#!/usr/bin/env bash

set -Eeuo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd)/lib.sh"

target_ref=""
backend_ref=""
frontend_ref=""
fetch_tags=true
rollback_on_failure=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-fetch) fetch_tags=false; shift ;;
    --backend-ref) [[ $# -ge 2 ]] || die "--backend-ref 缺少参数"; backend_ref="$2"; shift 2 ;;
    --frontend-ref) [[ $# -ge 2 ]] || die "--frontend-ref 缺少参数"; frontend_ref="$2"; shift 2 ;;
    --rollback-on-failure) rollback_on_failure=true; shift ;;
    --help)
      echo "用法：bash deploy/upgrade.sh [共同 Git 标签] [--backend-ref 引用] [--frontend-ref 引用] [--no-fetch] [--rollback-on-failure]"
      exit 0
      ;;
    -*) die "未知参数：$1" ;;
    *) [[ -z "$target_ref" ]] || die "只能指定一个目标版本"; target_ref="$1"; shift ;;
  esac
done

if [[ -n "$target_ref" && ( -n "$backend_ref" || -n "$frontend_ref" ) ]]; then
  die "共同版本参数不能与 --backend-ref/--frontend-ref 同时使用"
fi
if [[ -n "$target_ref" ]]; then
  backend_ref="$target_ref"
  frontend_ref="$target_ref"
fi

require_command docker
require_command git
require_command flock
load_production_env
ensure_directories
[[ -n "$FRONTEND_ROOT" ]] || die "找不到同级 NPClassworks 前端仓库"
require_clean_repository "$REPO_ROOT" "后端仓库"
require_clean_repository "$FRONTEND_ROOT" "前端仓库"

exec 9>"$RUNTIME_DIR/upgrade.lock"
flock -w 900 9 || die "等待其他升级完成超时，请检查部署进程"

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

if [[ -n "$backend_ref" || -n "$frontend_ref" ]]; then
  if [[ "$fetch_tags" == true ]]; then
    git -C "$REPO_ROOT" fetch --tags --prune
    git -C "$FRONTEND_ROOT" fetch --tags --prune
  fi
  if [[ -n "$backend_ref" ]]; then
    git -C "$REPO_ROOT" rev-parse --verify "$backend_ref^{commit}" >/dev/null || die "后端仓库不存在版本：$backend_ref"
    git -C "$REPO_ROOT" checkout --detach "$backend_ref"
  fi
  if [[ -n "$frontend_ref" ]]; then
    git -C "$FRONTEND_ROOT" rev-parse --verify "$frontend_ref^{commit}" >/dev/null || die "前端仓库不存在版本：$frontend_ref"
    git -C "$FRONTEND_ROOT" checkout --detach "$frontend_ref"
  fi
fi

log "构建并启动新版本"
node "$REPO_ROOT/scripts/check-production-env.js" "$ENV_FILE"
compose build --pull backend frontend
compose_application_up -d
if ! wait_for_backend 45; then
  if [[ "$rollback_on_failure" == true ]]; then
    log "新版本健康检查失败，正在自动恢复上一组应用镜像"
    bash "$DEPLOY_DIR/rollback.sh" || die "自动回滚也失败，请立即人工检查容器与数据库状态"
    die "升级健康检查失败，已自动恢复上一组应用镜像；请查看容器日志后再重试"
  fi
  die "升级后端未能就绪。可运行：bash deploy/rollback.sh"
fi

log "升级完成。升级前备份：$backup_file"
log "如需回滚应用：bash deploy/rollback.sh"
log "如需连数据库回滚：bash deploy/rollback.sh --restore-database --yes"
