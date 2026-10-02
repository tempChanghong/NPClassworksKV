#!/usr/bin/env bash

set -Eeuo pipefail
DEPLOY_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "请使用 sudo 运行此安装脚本" >&2; exit 1; }
[[ -f "$DEPLOY_DIR/.env.production" ]] || { echo "找不到 $DEPLOY_DIR/.env.production" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "当前系统不支持 systemd" >&2; exit 1; }

cat > /etc/systemd/system/npclassworks-backup.service <<EOF
[Unit]
Description=NPClassworks PostgreSQL backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
ExecStart=/usr/bin/env bash $DEPLOY_DIR/backup.sh --label scheduled
EOF

cat > /etc/systemd/system/npclassworks-backup.timer <<'EOF'
[Unit]
Description=Daily NPClassworks PostgreSQL backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15m
Persistent=true
Unit=npclassworks-backup.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now npclassworks-backup.timer
systemctl list-timers npclassworks-backup.timer --no-pager
