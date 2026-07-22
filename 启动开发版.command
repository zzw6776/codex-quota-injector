#!/bin/zsh

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Finder 启动的 .command 不一定继承交互式终端中的 PATH。
export PATH="$HOME/.volta/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi

pause_on_error() {
  echo
  read -r "?Press Enter to close..."
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required."
  pause_on_error
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  echo "Node.js 22 or newer is required. Current version: $(node --version 2>/dev/null)"
  pause_on_error
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  echo "Installing dependencies for the first launch..."
  if ! npm install; then
    echo "Failed to install dependencies."
    pause_on_error
    exit 1
  fi
fi

echo "Stopping any running Codex Quota Injector..."
injector_pids=()
while IFS= read -r pid; do
  if [[ "$pid" =~ '^[0-9]+$' ]]; then
    injector_pids+=("$pid")
  fi
done < <(/usr/sbin/lsof -nP -iTCP:49229 -sTCP:LISTEN -t 2>/dev/null)

if (( ${#injector_pids[@]} > 0 )); then
  kill -TERM "${injector_pids[@]}" 2>/dev/null || true
fi
/usr/bin/pkill -TERM -x "Codex Quota Injector" 2>/dev/null || true

for _ in {1..20}; do
  if ! /usr/sbin/lsof -nP -iTCP:49229 -sTCP:LISTEN -t >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

remaining_pids=()
while IFS= read -r pid; do
  if [[ "$pid" =~ '^[0-9]+$' ]]; then
    remaining_pids+=("$pid")
  fi
done < <(/usr/sbin/lsof -nP -iTCP:49229 -sTCP:LISTEN -t 2>/dev/null)
if (( ${#remaining_pids[@]} > 0 )); then
  kill -KILL "${remaining_pids[@]}" 2>/dev/null || true
fi

echo "Starting Codex Quota Injector development version..."
if ! npm run launch; then
  echo "Launch failed. Check the message above or injector.log."
  pause_on_error
  exit 1
fi
