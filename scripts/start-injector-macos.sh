#!/bin/bash

set -e
cd "$(cd -- "$(dirname -- "$0")/.." && pwd)"

# Finder 启动的 .command 不一定继承交互式终端中的 PATH。
export PATH="$HOME/.volta/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required."
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  echo "Node.js 22 or newer is required. Current version: $(node --version 2>/dev/null)"
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  echo "Installing dependencies for the first launch..."
  if ! npm install; then
    echo "Failed to install dependencies."
    exit 1
  fi
fi

echo "Starting Codex Quota Injector development version..."
exec npm run launch
