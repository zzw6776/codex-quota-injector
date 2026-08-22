#!/usr/bin/env node

process.env.CODEX_QUOTA_ROLE = "app-server-relay";

void import("./app-server-relay.mjs")
  .then(({ runAppServerRelay }) => runAppServerRelay())
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
