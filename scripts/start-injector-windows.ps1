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

function Test-CodexRunsInWsl {
  $configPath = Join-Path $HOME ".codex\config.toml"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    return $false
  }
  $inDesktopSection = $false
  foreach ($line in Get-Content -LiteralPath $configPath -ErrorAction SilentlyContinue) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^\[([^\]]+)\]$') {
      $inDesktopSection = $Matches[1] -eq "desktop"
      continue
    }
    if ($inDesktopSection -and
      $trimmed -match '^runCodexInWindowsSubsystemForLinux\s*=\s*(true|false)(?:\s+#.*)?$') {
      return $Matches[1] -eq "true"
    }
  }
  return $false
}

function Test-WslRelayFile(
  [string]$nodeExecutable,
  [string]$relayBuilder,
  [string]$relayExecutable
) {
  if (-not (Test-Path -LiteralPath $relayExecutable -PathType Leaf)) {
    return $false
  }
  $verifyOutput = @()
  $verifyExitCode = 1
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $verifyOutput = & $nodeExecutable $relayBuilder "--verify" $relayExecutable 2>&1
    $verifyExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  foreach ($line in $verifyOutput) {
    Write-LauncherLog "[wsl-relay-verify] $line"
  }
  return $verifyExitCode -eq 0
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

  $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw |
    ConvertFrom-Json

  if (Test-CodexRunsInWsl) {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
      throw "Codex is configured to use WSL, but wsl.exe was not found"
    }
    $relayExecutable = Join-Path $projectRoot "build\codex-quota-relay-wsl-$($package.version)"
    $relayBuilder = Join-Path $projectRoot "scripts\build-wsl-relay.mjs"
    $relayValid = Test-WslRelayFile $nodeExecutable $relayBuilder $relayExecutable
    if (-not $relayValid) {
      if (Test-Path -LiteralPath $relayExecutable -PathType Leaf) {
        Write-LauncherLog "Removing invalid cached WSL SEA development relay"
        Remove-Item -LiteralPath $relayExecutable -Force
      }
      Write-LauncherLog "Preparing native WSL SEA development relay"
      $linuxNode = Join-Path $projectRoot "runtime\node-v22.23.1-linux-x64\bin\node"
      if (-not (Test-Path -LiteralPath $linuxNode -PathType Leaf)) {
        throw "Packaged Linux Node runtime is missing: $linuxNode"
      }
      $relayBuildArguments = @(
        "--node-binary",
        $linuxNode,
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
        Write-LauncherLog "[wsl-relay] $line"
      }
      $relayValid = ($relayBuildExitCode -eq 0) -and (Test-WslRelayFile $nodeExecutable $relayBuilder $relayExecutable)
      if (-not $relayValid) {
        throw "WSL SEA development relay build failed; exitCode=$relayBuildExitCode; target=$relayExecutable"
      }
    } else {
      Write-LauncherLog "Reusing native WSL SEA development relay"
    }
    Write-LauncherLog "Using native WSL SEA development relay: $relayExecutable"
  } else {
    $relayExecutable = Join-Path $projectRoot "build\codex-quota-relay-windows-$($package.version).exe"
    if (-not (Test-Path -LiteralPath $relayExecutable -PathType Leaf)) {
      Write-LauncherLog "Preparing native Windows SEA development relay"
      $relayBuilder = Join-Path $projectRoot "scripts\build-windows-relay.mjs"
      $relayBuildArguments = @(
        "--node",
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
      if ($relayBuildExitCode -ne 0 -or -not $relayInfo -or $relayInfo.Length -lt 10MB) {
        throw "Windows SEA development relay build failed; exitCode=$relayBuildExitCode; target=$relayExecutable"
      }
    } else {
      $relayInfo = Get-Item -LiteralPath $relayExecutable -ErrorAction Stop
      if ($relayInfo.Length -lt 10MB) {
        throw "Windows SEA development relay is invalid"
      }
      Write-LauncherLog "Reusing native Windows SEA development relay"
    }
    Write-LauncherLog "Using native Windows SEA development relay: $relayExecutable"
  }
  $env:CODEX_QUOTA_RELAY_EXECUTABLE = $relayExecutable
  $env:CODEX_QUOTA_EXPLICIT_START = "1"

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
