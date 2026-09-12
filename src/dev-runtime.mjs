import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Only the self-contained Widget module can be reloaded in place. Any other
// runtime or dependency change must keep using the normal upgrade path.
export async function readDevRuntimeIdentity(root = fileURLToPath(new URL("../", import.meta.url))) {
  const directory = await realpath(root);
  const hash = createHash("sha256");
  const add = (name, value) => hash.update(name).update("\0").update(value).update("\0");
  add("runtime", JSON.stringify([directory, process.execPath, process.version]));
  add("environment", JSON.stringify(Object.entries(process.env)
    .filter(([name]) => name.startsWith("CODEX_QUOTA_") || name === "NODE_OPTIONS")
    .sort(([left], [right]) => left.localeCompare(right))));
  async function visit(relative) {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(relative, entry.name);
      if (path === join("src", "widget.mjs")) continue;
      if (entry.isDirectory()) await visit(path);
      else add(path, await readFile(join(directory, path)));
    }
  }
  await visit("src");
  for (const file of ["package.json", "package-lock.json"]) {
    const value = JSON.parse(await readFile(join(directory, file), "utf8"));
    delete value.version;
    if (file === "package-lock.json" && value.packages?.[""]) delete value.packages[""].version;
    add(file, JSON.stringify(value));
  }
  return hash.digest("hex");
}

export async function loadDevWidget() {
  const url = new URL("./widget.mjs", import.meta.url);
  const content = await readFile(url);
  url.searchParams.set("revision", createHash("sha256").update(content).digest("hex"));
  const widget = await import(url.href);
  for (const name of [
    "widgetInstallExpression", "widgetDrainActionsExpression", "widgetRuntimeVersionExpression",
    "widgetUpdateExpressionJson", "widgetTokenUsageDeltaUpdateExpressionJson",
  ]) {
    if (typeof widget[name] !== "function") throw new Error(`页面模块缺少 ${name}`);
  }
  if (!Number.isInteger(widget.WIDGET_RUNTIME_VERSION)) throw new Error("页面模块版本无效");
  return widget;
}
