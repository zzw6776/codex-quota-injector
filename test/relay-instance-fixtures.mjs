import { readFile } from "node:fs/promises";
import { listRelayInstances } from "../src/relay-instance-paths.mjs";

export async function readInstanceJson(base) {
  const files = await listRelayInstances(base);
  if (files.length !== 1) return null;
  return JSON.parse(await readFile(files[0].path, "utf8"));
}
