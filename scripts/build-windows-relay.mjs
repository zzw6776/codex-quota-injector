#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "win32") {
  throw new Error("Windows relay 只能在 Windows 环境构建");
}

const options = parseOptions(process.argv.slice(2));
const root = resolve(import.meta.dirname, "..");
const nodeBinary = resolve(options.nodeBinary ?? process.execPath);
const output = resolve(options.output ?? resolve(root, "build", "codex-quota-relay.exe"));

await mkdir(dirname(output), { recursive: true });

const cscExecutable = await findCscExecutable();
if (cscExecutable) {
  await buildWithCsc(cscExecutable, output);
} else {
  execFileSync(process.execPath, [
    resolve(root, "scripts", "build-sea.mjs"),
    "--node-binary",
    nodeBinary,
    "--output",
    output,
  ], { cwd: root, stdio: "inherit" });
}

const outputInfo = await stat(output).catch(() => null);
if (!outputInfo?.isFile() || outputInfo.size <= 0) {
  throw new Error(`Windows relay 构建未生成有效文件: ${output}`);
}
console.log(`Windows 开发版 relay 已就绪: ${output}`);

async function buildWithCsc(csc, targetPath) {
  const temporaryCsFile = join(dirname(targetPath), `.dev-relay.${process.pid}.${Date.now()}.cs`);
  const csSource = `
using System;
using System.Diagnostics;
using System.IO;

class Program {
    static int Main(string[] args) {
        string selfDir = AppDomain.CurrentDomain.BaseDirectory;
        string projectRoot = Path.GetFullPath(Path.Combine(selfDir, ".."));
        string launcherScript = Path.Combine(projectRoot, "src", "launcher.mjs");

        string nodeExecutable = Environment.GetEnvironmentVariable("CODEX_QUOTA_DEV_NODE");
        if (string.IsNullOrEmpty(nodeExecutable) || !File.Exists(nodeExecutable)) {
            nodeExecutable = Path.Combine(projectRoot, "build", "node-runtimes", "node-v22.23.1-win-x64", "node.exe");
            if (!File.Exists(nodeExecutable)) {
                nodeExecutable = "node.exe";
            }
        }

        var startInfo = new ProcessStartInfo {
            FileName = nodeExecutable,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.Arguments = "\\"" + launcherScript + "\\"";
        foreach (var arg in args) {
            startInfo.Arguments += " \\"" + arg.Replace("\\"", "\\\\\\"") + "\\"";
        }

        try {
            using (var proc = Process.Start(startInfo)) {
                proc.WaitForExit();
                return proc.ExitCode;
            }
        } catch (Exception ex) {
            Console.Error.WriteLine("[dev-relay] 启动失败: " + ex.Message);
            return 1;
        }
    }
}
`;
  try {
    await writeFile(temporaryCsFile, csSource, "utf8");
    execFileSync(csc, [
      "/nologo",
      "/target:exe",
      "/optimize+",
      `/out:${targetPath}`,
      temporaryCsFile,
    ], { windowsHide: true });
  } finally {
    await unlink(temporaryCsFile).catch(() => undefined);
  }
}

async function findCscExecutable() {
  const winDir = process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    join(winDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(winDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.F_OK);
      return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function parseOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--node-binary") values.nodeBinary = args[++index];
    if (key === "--output") values.output = args[++index];
  }
  return values;
}
