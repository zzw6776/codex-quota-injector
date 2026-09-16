function parseProcessList(processList, executable) {
  const processIds = [];
  for (const line of String(processList).split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match?.[2] === executable) processIds.push(Number(match[1]));
  }
  return processIds;
}

function parseMacCodexLifecycleProcesses(processList, executable) {
  const marker = ".app/Contents/MacOS/";
  const markerIndex = String(executable).lastIndexOf(marker);
  if (markerIndex < 0) return [];
  const bundlePath = String(executable).slice(0, markerIndex + 4);
  const bareModifierPath = `${bundlePath}/Contents/Resources/native/bare-modifier-monitor`;
  const frameworkPrefix = `${bundlePath}/Contents/Frameworks/`;
  const crashpadSuffix = "/Helpers/browser_crashpad_handler";
  const processes = [];
  for (const line of String(processList).split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const executablePath = match[2];
    let role = null;
    if (executablePath === executable) role = "desktop";
    else if (executablePath === bareModifierPath) role = "bare-modifier-monitor";
    else if (executablePath.startsWith(frameworkPrefix) &&
      executablePath.endsWith(crashpadSuffix)) role = "browser-crashpad-handler";
    if (role) processes.push({
      pid: Number(match[1]),
      executablePath,
      role,
    });
  }
  return processes;
}

export { parseProcessList, parseMacCodexLifecycleProcesses };
