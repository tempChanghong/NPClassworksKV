#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' '旧工作区备份定时器安装器已停用。请使用 NPEssentials 的直接 PostgreSQL 异地备份调度；核对旧 timer 状态后再由管理员迁移。' >&2
exit 1
