function ConvertTo-WindowsProcessArgument {
  param([AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Reset-WindowsDevLauncherEnvironment {
  # A developer can run the launcher from a Codex terminal whose parent is the
  # app-server relay. These variables describe that child process and must not
  # make the new launcher enter relay mode itself.
  foreach ($name in @(
    "CODEX_QUOTA_RELAY_CONFIG",
    "CODEX_QUOTA_ROLE",
    "CODEX_QUOTA_ROUTER_TOKEN",
    "CODEX_QUOTA_UPSTREAM_CODEX_CLI"
  )) {
    Remove-Item -LiteralPath "Env:$name" -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-WindowsProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $temporaryName = "codex-quota-process-$([guid]::NewGuid().ToString('N'))"
  $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) "$temporaryName.stdout.log"
  $stderrPath = Join-Path ([IO.Path]::GetTempPath()) "$temporaryName.stderr.log"
  try {
    $argumentLine = (@($Arguments | ForEach-Object {
      ConvertTo-WindowsProcessArgument $_
    }) -join ' ')
    $process = Start-Process `
      -FilePath $Executable `
      -ArgumentList $argumentLine `
      -WorkingDirectory (Get-Location).ProviderPath `
      -NoNewWindow `
      -PassThru `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -ErrorAction Stop
    # Keep the process handle before it exits so Windows PowerShell 5.1 can
    # retrieve its real exit code when Start-Process is used without -Wait.
    $null = $process.Handle
    if ($script:WindowsDevProcessOutputHandler) {
      . (Join-Path $PSScriptRoot "dev-launch-log-reader.ps1")
      $streams = @(New-DevLogCursor $stdoutPath; New-DevLogCursor $stderrPath)
      do {
        foreach ($stream in $streams) {
          Read-DevLogCursor $stream -OnOutput $script:WindowsDevProcessOutputHandler
        }
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 100
        $process.Refresh()
      } while ($true)
      foreach ($stream in $streams) {
        Read-DevLogCursor $stream -OnOutput $script:WindowsDevProcessOutputHandler
      }
    }
    $process.WaitForExit()
    $process.Refresh()
    $output = @()
    if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) {
      $output += @(Get-Content -LiteralPath $stdoutPath -ErrorAction Stop)
    }
    if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
      $output += @(Get-Content -LiteralPath $stderrPath -ErrorAction Stop)
    }
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      Output = $output
    }
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-WindowsNpmCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,
    [Parameter(Mandatory = $true)]
    [string]$NpmCli,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $nodeArguments = @($NpmCli)
  $nodeArguments += $Arguments
  return Invoke-WindowsProcess -Executable $NodeExecutable -Arguments $nodeArguments
}

function Sync-WindowsDevDependencies {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,
    [Parameter(Mandatory = $true)]
    [string]$NpmCli,
    [Parameter(Mandatory = $true)]
    [string]$LogPath
  )

  Push-Location -LiteralPath $ProjectRoot
  try {
    $check = Invoke-WindowsNpmCommand -NodeExecutable $NodeExecutable -NpmCli $NpmCli `
      -Arguments @("ls", "--all", "--silent")
    if ($check.ExitCode -eq 0) {
      return $false
    }

    Add-Content -LiteralPath $LogPath `
      -Value "$(Get-Date -Format o) Dependency tree is incomplete; running npm install" `
      -Encoding UTF8
    foreach ($line in $check.Output) {
      Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) [npm-check] $line" -Encoding UTF8
    }

    $install = Invoke-WindowsNpmCommand -NodeExecutable $NodeExecutable -NpmCli $NpmCli -Arguments @(
      "install",
      "--no-audit",
      "--no-fund"
    )
    foreach ($line in $install.Output) {
      Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) [npm-install] $line" -Encoding UTF8
    }
    if ($install.ExitCode -ne 0) {
      throw "npm install failed with exit code $($install.ExitCode)"
    }

    $verify = Invoke-WindowsNpmCommand -NodeExecutable $NodeExecutable -NpmCli $NpmCli `
      -Arguments @("ls", "--all", "--silent")
    foreach ($line in $verify.Output) {
      Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) [npm-verify] $line" -Encoding UTF8
    }
    if ($verify.ExitCode -ne 0) {
      throw "Dependency tree is still incomplete after npm install; exit code $($verify.ExitCode)"
    }
    return $true
  } finally {
    Pop-Location
  }
}
