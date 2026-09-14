#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  findWindowsNodeExecutable,
  isWslRuntime,
  toWindowsPath,
} from "./windows-test-host.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function verifyWindowsComputerUseFixture({ marker, evidence }) {
  if (!marker || evidence?.schemaVersion !== 1 || evidence.marker !== marker) {
    throw new Error("Windows Computer Use 证据格式或随机标记无效");
  }
  if (evidence.launchCount !== 1) {
    throw new Error(`预期测试应用只启动一次，实际 ${evidence.launchCount ?? "missing"} 次`);
  }
  if (!Array.isArray(evidence.submissions) || evidence.submissions.length !== 1) {
    throw new Error(`预期恰好一次提交，实际 ${evidence.submissions?.length ?? "missing"} 次`);
  }
  if (evidence.submissions[0]?.value !== marker) {
    throw new Error("提交值与本轮随机标记不一致");
  }
  return { launchCount: 1, submissionCount: 1 };
}

export function windowsComputerUseFixtureSource({ evidencePath, marker }) {
  const markerBase64 = Buffer.from(marker, "utf8").toString("base64");
  const evidencePathBase64 = Buffer.from(evidencePath, "utf8").toString("base64");
  return `using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class Submission {
    public string value;
    public string at;
}

internal sealed class Evidence {
    public int schemaVersion = 1;
    public string marker;
    public int launchCount;
    public List<Submission> submissions = new List<Submission>();
}

internal sealed class FixtureForm : Form {
    private readonly string marker;
    private readonly string evidencePath;
    private readonly Evidence evidence;
    private readonly TextBox input;
    private readonly Label result;

    internal FixtureForm(string markerValue, string evidencePathValue) {
        marker = markerValue;
        evidencePath = evidencePathValue;
        evidence = ReadEvidence();
        evidence.launchCount += 1;
        Text = "Codex Computer Use " + marker.Substring(0, Math.Min(20, marker.Length));
        AccessibleName = "Codex Computer Use fixture";
        ClientSize = new Size(720, 330);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 12F);

        var instruction = new Label {
            AccessibleName = "Instruction",
            AutoSize = true,
            Location = new Point(28, 26),
            Text = "读取随机标记，在输入框中输入相同内容，然后只提交一次。"
        };
        var markerLabel = new Label {
            AccessibleName = "Random marker " + marker,
            AutoSize = true,
            Font = new Font("Consolas", 13F, FontStyle.Bold),
            Location = new Point(28, 76),
            Name = "MarkerLabel",
            Text = marker
        };
        input = new TextBox {
            AccessibleName = "Marker input",
            Location = new Point(28, 126),
            Name = "MarkerInput",
            Size = new Size(650, 32)
        };
        var submit = new Button {
            AccessibleName = "Submit marker",
            Location = new Point(28, 184),
            Name = "SubmitButton",
            Size = new Size(130, 42),
            Text = "提交"
        };
        result = new Label {
            AccessibleName = "Submission result",
            AutoSize = true,
            Location = new Point(28, 250),
            Name = "ResultLabel",
            Text = "等待提交"
        };
        submit.Click += Submit;
        Controls.AddRange(new Control[] { instruction, markerLabel, input, submit, result });
        AcceptButton = submit;
        Shown += delegate { WriteEvidence(); input.Focus(); };
    }

    private void Submit(object sender, EventArgs args) {
        evidence.submissions.Add(new Submission {
            value = input.Text,
            at = DateTime.UtcNow.ToString("o")
        });
        WriteEvidence();
        result.Text = input.Text == marker && evidence.submissions.Count == 1
            ? "验收成功"
            : "标记不匹配或发生重复提交";
        if (IsHandleCreated && input.Text == marker && evidence.launchCount == 1 && evidence.submissions.Count == 1) {
            BeginInvoke(new Action(Close));
        }
    }

    internal void RunSelfTest() {
        input.Text = marker;
        Submit(this, EventArgs.Empty);
    }

    private Evidence ReadEvidence() {
        if (!File.Exists(evidencePath)) return new Evidence { marker = marker };
        try {
            var serializer = new JavaScriptSerializer();
            var existing = serializer.Deserialize<Evidence>(File.ReadAllText(evidencePath, Encoding.UTF8));
            if (existing == null || existing.schemaVersion != 1 || existing.marker != marker) {
                return new Evidence { marker = marker };
            }
            if (existing.submissions == null) existing.submissions = new List<Submission>();
            return existing;
        } catch {
            return new Evidence { marker = marker };
        }
    }

    private void WriteEvidence() {
        Directory.CreateDirectory(Path.GetDirectoryName(evidencePath));
        var serializer = new JavaScriptSerializer();
        var temporary = evidencePath + ".tmp";
        File.WriteAllText(temporary, serializer.Serialize(evidence), new UTF8Encoding(false));
        if (File.Exists(evidencePath)) File.Delete(evidencePath);
        File.Move(temporary, evidencePath);
    }
}

internal static class Program {
    [STAThread]
    private static void Main(string[] args) {
        var marker = Encoding.UTF8.GetString(Convert.FromBase64String("${markerBase64}"));
        var evidencePath = Encoding.UTF8.GetString(Convert.FromBase64String("${evidencePathBase64}"));
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new FixtureForm(marker, evidencePath);
        if (args.Length == 1 && args[0] == "--self-test") {
            form.RunSelfTest();
            return;
        }
        Application.Run(form);
    }
}
`;
}

function parseOptions(args) {
  const options = {
    nativeChild: false,
    resultDirectory: resolve(import.meta.dirname, "../.runtime/test-results/desktop-host"),
    runId: createRunId(),
    selfTest: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    verifyPath: null,
  };
  for (const argument of args) {
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? null : argument.slice(separator + 1);
    if (name === "--native-child" && value === null) options.nativeChild = true;
    else if (name === "--result-dir" && value) options.resultDirectory = resolve(value);
    else if (name === "--run-id" && value && /^[a-zA-Z0-9._-]+$/.test(value)) options.runId = value;
    else if (name === "--self-test" && value === null) options.selfTest = true;
    else if (name === "--timeout-ms" && /^\d+$/.test(value ?? "")) options.timeoutMs = Number(value);
    else if (name === "--verify" && value) options.verifyPath = resolve(value);
    else throw new Error(`未知参数 ${argument}`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms 必须是不小于 1000 的整数");
  }
  if (options.verifyPath && (options.nativeChild || options.selfTest)) {
    throw new Error("--verify 不能与执行参数同时使用");
  }
  return options;
}

export async function prepareWindowsComputerUseFixture({
  resultDirectory,
  runId,
  marker = `WINDOWS_CU_${randomBytes(8).toString("hex")}`,
} = {}) {
  if (process.platform !== "win32") throw new Error("Windows Computer Use 材料必须由 Windows Node.js 运行");
  if (!resultDirectory || !runId || !marker) throw new Error("Windows Computer Use 材料缺少目录、运行编号或标记");
  const runDirectory = join(resultDirectory, runId);
  await mkdir(runDirectory, { recursive: true });
  const sourcePath = join(runDirectory, "computer-use-fixture.cs");
  const executablePath = join(runDirectory, `computer-use-fixture-${runId}.exe`);
  const evidencePath = join(runDirectory, "computer-use-evidence.json");
  const manifestPath = join(runDirectory, "computer-use-fixture.json");
  await rm(evidencePath, { force: true });
  await writeFile(sourcePath, windowsComputerUseFixtureSource({ evidencePath, marker }));
  const compiler = await findCSharpCompiler();
  await execFileAsync(compiler, [
    "/nologo",
    "/target:winexe",
    `/out:${executablePath}`,
    "/reference:System.Drawing.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Windows.Forms.dll",
    sourcePath,
  ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const manifest = {
    schemaVersion: 1,
    kind: "windows-native-computer-use",
    runId,
    status: "waiting",
    marker,
    executablePath,
    evidencePath,
    createdAt: new Date().toISOString(),
    completedAt: null,
    evidence: null,
    error: null,
  };
  await persistManifest(manifestPath, manifest);
  return { ...manifest, manifestPath };
}

export async function readWindowsComputerUseFixture(prepared) {
  const evidence = await readFile(prepared.evidencePath, "utf8").then(JSON.parse, error =>
    error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!evidence) return null;
  return { ...prepared, evidence };
}

async function runWindowsFixture(options) {
  const prepared = await prepareWindowsComputerUseFixture({
    resultDirectory: options.resultDirectory,
    runId: options.runId,
  });
  const manifest = { ...prepared };
  const { marker, executablePath, evidencePath, manifestPath } = prepared;
  process.stdout.write(`${JSON.stringify({
    runId: options.runId,
    executablePath,
    manifestPath,
    marker,
    instruction: options.selfTest
      ? "正在执行 Windows 原生材料自检。"
      : "使用实际 Computer Use 启动 executablePath；从窗口读取 marker，输入相同内容并只激活一次提交。",
  }, null, 2)}\n`);
  if (options.selfTest) {
    await execFileAsync(executablePath, ["--self-test"], { windowsHide: true, timeout: 30_000 });
  }
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const evidence = (await readWindowsComputerUseFixture(prepared))?.evidence ?? null;
    if (evidence?.submissions?.length) {
      manifest.evidence = evidence;
      manifest.completedAt = new Date().toISOString();
      try {
        verifyWindowsComputerUseFixture({ marker, evidence });
        manifest.status = "passed";
      } catch (error) {
        manifest.status = "failed";
        manifest.error = error.message;
      }
      await persistManifest(manifestPath, manifest);
      if (manifest.status !== "passed") throw new Error(manifest.error);
      process.stdout.write(`${JSON.stringify({ passed: true, manifestPath })}\n`);
      return;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
  }
  manifest.status = "timed-out";
  manifest.completedAt = new Date().toISOString();
  manifest.error = "等待 Windows Computer Use 提交超时";
  await persistManifest(manifestPath, manifest);
  throw new Error(manifest.error);
}

async function delegateToWindows(options) {
  const windowsNode = await findWindowsNodeExecutable();
  const scriptPath = await toWindowsPath(resolve(process.argv[1]));
  const resultDirectory = await toWindowsPath(options.resultDirectory);
  const args = [
    scriptPath,
    "--native-child",
    `--result-dir=${resultDirectory}`,
    `--run-id=${options.runId}`,
    `--timeout-ms=${options.timeoutMs}`,
    ...(options.selfTest ? ["--self-test"] : []),
  ];
  const child = spawn(windowsNode, args, { stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
  });
  if (code !== 0) throw new Error(`Windows 原生 Computer Use 材料退出码 ${code}`);
}

async function verifyManifest(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.kind !== "windows-native-computer-use" || manifest.status !== "passed") {
    throw new Error(`Windows Computer Use 材料状态不是 passed，而是 ${manifest.status ?? "missing"}`);
  }
  const summary = verifyWindowsComputerUseFixture(manifest);
  process.stdout.write(`${JSON.stringify({ passed: true, path, summary }, null, 2)}\n`);
}

async function findCSharpCompiler() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error("未找到 Windows 自带的 .NET Framework C# 编译器，无法生成原生 Computer Use 材料");
}

function createRunId() {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

async function persistManifest(path, manifest) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.verifyPath) return verifyManifest(options.verifyPath);
  if (options.nativeChild && process.platform !== "win32") {
    throw new Error("--native-child 只能由 Windows Node.js 使用");
  }
  if (!options.nativeChild && isWslRuntime()) return delegateToWindows(options);
  return runWindowsFixture(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
