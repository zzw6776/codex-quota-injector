#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h}"
CHATGPT_APP="/Applications/ChatGPT.app"
NODE_BIN="$CHATGPT_APP/Contents/Resources/cua_node/bin/node"
RUNTIME_DIR="$PROJECT_DIR/.runtime"
NAMED_NODE_BIN="$RUNTIME_DIR/Codex Quota Injector"
CDP_PORT="${CODEX_QUOTA_CDP_PORT:-9229}"
LOG_DIR="$HOME/Library/Logs/Codex Quota Injector"
LAUNCH_LABEL="com.codex-quota-injector.agent"
LAUNCH_PLIST="$PROJECT_DIR/$LAUNCH_LABEL.plist"
LAUNCH_DOMAIN="gui/$(id -u)"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "未找到 Codex 自带的 Node.js：$NODE_BIN"
  read -k 1 "?按任意键退出…"
  exit 1
fi

mkdir -p "$LOG_DIR"
mkdir -p "$RUNTIME_DIR"

if pgrep -x ChatGPT >/dev/null 2>&1; then
  pkill -TERM -x ChatGPT >/dev/null 2>&1 || true
  for _ in {1..40}; do
    pgrep -x ChatGPT >/dev/null 2>&1 || break
    sleep 0.25
  done
fi

launchctl bootout "$LAUNCH_DOMAIN/$LAUNCH_LABEL" >/dev/null 2>&1 || true
pkill -TERM -f "$PROJECT_DIR/src/cli.mjs inject" >/dev/null 2>&1 || true
for _ in {1..20}; do
  pgrep -f "$PROJECT_DIR/src/cli.mjs inject" >/dev/null 2>&1 || break
  sleep 0.1
done
pkill -KILL -f "$PROJECT_DIR/src/cli.mjs inject" >/dev/null 2>&1 || true
ln -f "$NODE_BIN" "$NAMED_NODE_BIN"
launchctl bootstrap "$LAUNCH_DOMAIN" "$LAUNCH_PLIST"

open -na "$CHATGPT_APP" --args "--remote-debugging-address=127.0.0.1" "--remote-debugging-port=$CDP_PORT"

echo "Codex 已以动态注入模式启动。"
echo "日志：$LOG_DIR/injector.log"
sleep 2
