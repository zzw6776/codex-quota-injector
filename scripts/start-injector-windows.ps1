$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$appDataRoot = if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
  Join-Path $HOME "AppData\Roaming"
} else {
  $env:APPDATA
}
$localAppDataRoot = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  Join-Path $HOME "AppData\Local"
} else {
  $env:LOCALAPPDATA
}
$dataRoot = Join-Path $appDataRoot "Codex Quota Injector"
$logRoot = Join-Path $localAppDataRoot "Codex Quota Injector\Logs"
$bootstrapLog = Join-Path $logRoot "launcher.log"
$stdoutLog = Join-Path $logRoot "injector-stdout.log"
$stderrLog = Join-Path $logRoot "injector-stderr.log"

New-Item -ItemType Directory -Path $dataRoot, $logRoot -Force | Out-Null

function Write-LauncherLog([string]$message) {
  Add-Content -LiteralPath $bootstrapLog -Value "$(Get-Date -Format o) $message" -Encoding UTF8
}

try {
  Write-LauncherLog "Starting Windows development launcher"

  $projectNode = Join-Path $projectRoot "build\node-runtimes\node-v22.23.1-win-x64\node.exe"
  if (Test-Path -LiteralPath $projectNode) {
    $nodeExecutable = $projectNode
  } else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
      throw "Node.js 22.23.1 was not found"
    }
    $nodeExecutable = $nodeCommand.Path
    $nodeVersion = (& $nodeExecutable --version).Trim()
    if ($nodeVersion -notmatch '^v22\.') {
      throw "Windows development launcher requires Node.js 22, found $nodeVersion"
    }
  }

  $nodeModules = Join-Path $projectRoot "node_modules"
  if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
    throw "node_modules was not found; run npm install in the project directory first"
  }

  $relayBuilder = Join-Path $projectRoot "scripts\build-windows-relay.mjs"
  $relaySourceFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot "src") -Recurse -File
    Get-Item -LiteralPath (Join-Path $projectRoot "package.json")
    Get-Item -LiteralPath (Join-Path $projectRoot "package-lock.json")
    Get-Item -LiteralPath (Join-Path $projectRoot "scripts\build-sea.mjs")
    Get-Item -LiteralPath $relayBuilder
  )
  $relaySourceEntries = @(
    foreach ($sourceFile in $relaySourceFiles) {
      [pscustomobject]@{
        SortKey = -join ([Text.Encoding]::UTF8.GetBytes($sourceFile.FullName) |
          ForEach-Object { $_.ToString("X2") })
        SourceFile = $sourceFile
      }
    }
  ) | Sort-Object -Property SortKey
  $relayHashes = @(
    foreach ($sourceEntry in $relaySourceEntries) {
      (Get-FileHash -LiteralPath $sourceEntry.SourceFile.FullName -Algorithm SHA256).Hash
    }
  )
  $relayFingerprint = ($relayHashes -join "").Substring(0, 16).ToLowerInvariant()
  $relayExecutable = Join-Path $projectRoot "build\codex-quota-relay-$relayFingerprint.exe"
  if (-not (Test-Path -LiteralPath $relayExecutable -PathType Leaf)) {
    Write-LauncherLog ("Building Windows development relay ({0})" -f $relayFingerprint)
    $relayBuildArguments = @(
      "--node-binary",
      $nodeExecutable,
      "--output",
      $relayExecutable
    )
    $relayBuildOutput = @()
    $relayBuildExitCode = 1
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $relayBuildOutput = & $nodeExecutable $relayBuilder @relayBuildArguments 2>&1
      $relayBuildExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    foreach ($line in $relayBuildOutput) {
      Write-LauncherLog "[relay] $line"
    }
    $relayInfo = Get-Item -LiteralPath $relayExecutable -ErrorAction SilentlyContinue
    if ($relayBuildExitCode -ne 0 -or -not $relayInfo -or $relayInfo.Length -le 0) {
      throw "Windows development relay build failed; exitCode=$relayBuildExitCode; target=$relayExecutable"
    }
  } else {
    $relayInfo = Get-Item -LiteralPath $relayExecutable -ErrorAction Stop
    if ($relayInfo.Length -le 0) {
      throw "Windows development relay is empty"
    }
    Write-LauncherLog ("Reusing Windows development relay ({0})" -f $relayFingerprint)
  }
  $env:CODEX_QUOTA_RELAY_EXECUTABLE = $relayExecutable

  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
  $launcher = Join-Path $projectRoot "src\launcher.mjs"
  $process = Start-Process `
    -FilePath $nodeExecutable `
    -ArgumentList @("`"$launcher`"") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  Write-LauncherLog "Injector started in background; PID=$($process.Id); Node=$nodeExecutable"
} catch {
  Write-LauncherLog "Launcher failed: $($_.Exception.Message)"
  exit 1
}
