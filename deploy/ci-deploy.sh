#!/usr/bin/env bash

set -Eeuo pipefail
export GIT_TERMINAL_PROMPT=0

deploy_dir="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"

# 两个仓库各自解析自己的 origin/main；它们不需要拥有相同提交 SHA。
exec bash "$deploy_dir/upgrade.sh" \
  --backend-ref origin/main \
  --frontend-ref origin/main \
  --rollback-on-failure
