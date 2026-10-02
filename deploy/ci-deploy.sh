#!/usr/bin/env bash
# NP_DEPLOY_PROTOCOL=2

set -Eeuo pipefail
export GIT_TERMINAL_PROMPT=0

deploy_dir="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"

# CI must supply the exact pair that passed its gates. Never resolve a branch here.
if [[ $# -ne 2 || ! "$1" =~ ^[a-f0-9]{40}$ || ! "$2" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Expected tested backend and frontend full commit SHAs\n' >&2
  exit 2
fi
exec bash "$deploy_dir/upgrade.sh" \
  --backend-ref "$1" \
  --frontend-ref "$2" \
  --rollback-on-failure
