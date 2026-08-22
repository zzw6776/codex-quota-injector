#!/usr/bin/env node

// Codex Desktop only forwards a limited environment into its WSL app-server
// process. The dedicated SEA executable therefore declares its role itself.
process.env.CODEX_QUOTA_WSL_NATIVE = "1";

void import("./app-server-relay.mjs")
  .then(({ runAppServerRelay }) => runAppServerRelay())
  .catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
