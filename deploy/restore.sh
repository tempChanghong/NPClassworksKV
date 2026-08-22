#!/usr/bin/env bash

set -Eeuo pipefail
# shellcheck source=deploy/lib.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd)/lib.sh"

confirmed=false
skip_safety_backup=false
backup_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) confirmed=true; shift ;;
    --skip-safety-backup) skip_safety_backup=true; shift ;;
    --help)
      echo "用法：bash deploy/restore.sh <备份.dump> --yes [--skip-safety-backup]"
      exit 0
      ;;
    -*) die "未知参数：$1" ;;
    *) [[ -z "$backup_file" ]] || die "只能指定一个备份文件"; backup_file="$1"; shift ;;
  esac
done

[[ -n "$backup_file" ]] || die "请指定要恢复的 .dump 文件"
[[ "$confirmed" == true ]] || die "恢复会替换当前数据库；确认后请追加 --yes"
require_command docker
require_command sha256sum
require_command realpath
load_production_env
ensure_directories

backup_file="$(realpath "$backup_file")"
[[ -f "$backup_file" && "$backup_file" == *.dump ]] || die "备份文件不存在或扩展名不是 .dump"
case "$backup_file" in
  "$BACKUP_DIR"/*) ;;
  *) die "只允许恢复 $BACKUP_DIR 内的备份" ;;
esac

if [[ -f "$backup_file.sha256" ]]; then
  backup_parent="${backup_file%/*}"
  checksum_name="${backup_file##*/}.sha256"
  (cd "$backup_parent" && sha256sum --check "$checksum_name") >/dev/null || die "备份校验和不匹配"
fi
compose exec -T postgres pg_restore --list < "$backup_file" >/dev/null || die "备份文件无法读取"

if [[ "$skip_safety_backup" != true ]]; then
  safety_backup="$(bash "$DEPLOY_DIR/backup.sh" --label pre-restore)"
  log "当前数据库安全备份：$safety_backup"
fi

log "停止后端并恢复数据库 $POSTGRES_DB"
compose stop backend >/dev/null
restart_backend=true
trap 'if [[ "${restart_backend:-false}" == true ]]; then compose up -d backend >/dev/null 2>&1 || true; fi' EXIT

compose exec -T postgres dropdb --username "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB"
compose exec -T postgres createdb --username "$POSTGRES_USER" --owner "$POSTGRES_USER" "$POSTGRES_DB"
compose exec -T postgres pg_restore \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --exit-on-error \
  --no-owner \
  --no-privileges < "$backup_file"

compose up -d backend >/dev/null
wait_for_backend 45 || die "数据库已恢复，但后端未在预期时间内就绪；请检查 docker compose logs backend"
restart_backend=false
trap - EXIT
log "恢复完成：$backup_file"
