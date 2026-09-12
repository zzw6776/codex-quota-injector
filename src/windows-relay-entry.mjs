#!/usr/bin/env node

process.env.CODEX_QUOTA_ROLE = "app-server-relay";
// The desktop may invoke CODEX_CLI_PATH for auxiliary commands with only a
// reduced environment. The dedicated native relay can recover its persisted
// launch configuration without ever falling through to the injector entry.
process.env.CODEX_QUOTA_WINDOWS_NATIVE = "1";

void import("./app-server-relay.mjs")
  .then(({ runAppServerRelay }) => runAppServerRelay())
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
