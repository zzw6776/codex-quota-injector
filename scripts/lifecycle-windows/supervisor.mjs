import { quoteWindowsArgument, powershellQuote } from "./io.mjs";

function windowsScheduledTaskScript({
  taskName,
  nodeExecutable,
  supervisorScript,
  controlPath,
  workingDirectory,
} = {}) {
  const argument = `${quoteWindowsArgument(supervisorScript)} --control ${quoteWindowsArgument(controlPath)}`;
  return `
$ErrorActionPreference='Stop';
$user=([System.Security.Principal.WindowsIdentity]::GetCurrent().Name);
$action=New-ScheduledTaskAction -Execute '${powershellQuote(nodeExecutable)}' -Argument '${powershellQuote(argument)}' -WorkingDirectory '${powershellQuote(workingDirectory)}';
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user;
$settings=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 1);
Register-ScheduledTask -TaskName '${powershellQuote(taskName)}' -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null;
Start-ScheduledTask -TaskName '${powershellQuote(taskName)}';
`;
}

export { windowsScheduledTaskScript };
