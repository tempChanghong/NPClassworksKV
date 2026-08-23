#!/usr/bin/env bash

set -Eeuo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd)/lib.sh"

restore_database=false
confirmed=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore-database) restore_database=true; shift ;;
    --yes) confirmed=true; shift ;;
    --help)
      echo "用法：bash deploy/rollback.sh [--restore-database --yes]"
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

require_command docker
require_command git
load_production_env
ensure_directories
state_file="$RUNTIME_DIR/rollback-state.env"
[[ -f "$state_file" ]] || die "没有可用的升级回滚状态：$state_file"
# shellcheck disable=SC1090
source "$state_file"

require_clean_repository "$REPO_ROOT" "后端仓库"
require_clean_repository "$FRONTEND_ROOT" "前端仓库"
docker image inspect "$BACKEND_ROLLBACK_TAG" >/dev/null 2>&1 || die "上一后端镜像已经不存在"
docker image inspect "$FRONTEND_ROLLBACK_TAG" >/dev/null 2>&1 || die "上一前端镜像已经不存在"

if [[ "$restore_database" == true && "$confirmed" != true ]]; then
  die "数据库回滚会替换当前数据；确认后请追加 --yes"
fi

log "恢复上一组前后端镜像与代码版本"
docker tag "$BACKEND_ROLLBACK_TAG" npclassworks-backend:current
docker tag "$FRONTEND_ROLLBACK_TAG" npclassworks-frontend:current

if [[ "$restore_database" == true ]]; then
  bash "$DEPLOY_DIR/restore.sh" "$BACKUP_FILE" --yes
fi

git -C "$REPO_ROOT" checkout --detach "$PREVIOUS_BACKEND_REF"
git -C "$FRONTEND_ROOT" checkout --detach "$PREVIOUS_FRONTEND_REF"
compose_application_up -d --no-build --force-recreate
wait_for_backend 45 || die "应用镜像已回退，但后端未能就绪；数据库可能需要一起回滚"

log "回滚完成"
