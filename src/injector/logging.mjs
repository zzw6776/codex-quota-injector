import { DEBUG_LOGGING } from "./contract.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(message) {
  if (DEBUG_LOGGING) console.log(message);
}

export { delay, debugLog };
