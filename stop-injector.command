#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h}"
launchctl bootout "gui/$(id -u)/com.codex-quota-injector.agent" >/dev/null 2>&1 || true
pkill -TERM -f "$PROJECT_DIR/src/cli.mjs inject" >/dev/null 2>&1 || true
echo "额度注入器已停止；刷新或重启 Codex 后悬浮框会消失。"
sleep 2
