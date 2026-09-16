import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export function isCodexHostedDevLaunch(environment = process.env) {
  return Boolean(String(environment.CODEX_APP_TOOLS_PIPE_PATH ?? "").trim());
}

// The Widget entry and its browser feature modules can be reloaded in place. Any other
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
      if (path === join("src", "widget.mjs") || path === join("src", "widget")) continue;
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

export async function loadDevWidget(root = fileURLToPath(new URL("../", import.meta.url))) {
  // A fresh module graph avoids retaining cached child imports after a feature edit.
  // Read the complete snapshot before importing, and remove it after ESM linking.
  const sources = [["widget.mjs", await readFile(join(root, "src", "widget.mjs"))]];
  async function visit(relative) {
    const entries = await readdir(join(root, "src", relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) sources.push([path, await readFile(join(root, "src", path))]);
    }
  }
  await visit("widget");
  const snapshot = await mkdtemp(join(tmpdir(), "codex-quota-widget-"));
  let widget;
  try {
    for (const [relative, content] of sources) {
      const path = join(snapshot, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    widget = await import(pathToFileURL(join(snapshot, "widget.mjs")).href);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
  for (const name of [
    "widgetInstallExpression", "widgetDrainActionsExpression", "widgetRuntimeVersionExpression",
    "widgetUpdateExpressionJson", "widgetTokenUsageDeltaUpdateExpressionJson",
  ]) {
    if (typeof widget[name] !== "function") throw new Error(`页面模块缺少 ${name}`);
  }
  if (!Number.isInteger(widget.WIDGET_RUNTIME_VERSION)) throw new Error("页面模块版本无效");
  return widget;
}
