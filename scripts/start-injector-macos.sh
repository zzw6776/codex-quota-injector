#!/bin/bash

set -e
cd "$(cd -- "$(dirname -- "$0")/.." && pwd)"

source "$(pwd)/scripts/macos-dev-environment.sh"

if [[ ! -d "node_modules" ]]; then
  echo "Installing dependencies for the first launch..."
  if ! npm install; then
    echo "Failed to install dependencies."
    exit 1
  fi
fi

echo "Starting Codex Quota Injector development version..."
exec npm run launch
