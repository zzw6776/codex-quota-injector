function New-DevLogCursor {
  param([string]$Path, [switch]$FromEnd)
  $offset = 0L
  if ($FromEnd -and (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $offset = (Get-Item -LiteralPath $Path).Length
  }
  return [pscustomobject]@{
    Path = $Path
    Offset = $offset
    Decoder = [Text.Encoding]::UTF8.GetDecoder()
  }
}

function Read-DevLogCursor {
  param($Cursor, [scriptblock]$OnOutput = { param($text) Write-Host -NoNewline $text })
  if (-not (Test-Path -LiteralPath $Cursor.Path -PathType Leaf)) { return }
  $file = $null
  try {
    $file = [IO.File]::Open($Cursor.Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
      [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    if ($file.Length -lt $Cursor.Offset) {
      $Cursor.Offset = 0L
      $Cursor.Decoder.Reset()
    }
    [void]$file.Seek($Cursor.Offset, [IO.SeekOrigin]::Begin)
    $bytes = New-Object byte[] 8192
    $characters = New-Object char[] 8192
    while (($count = $file.Read($bytes, 0, $bytes.Length)) -gt 0) {
      $Cursor.Offset += $count
      $characterCount = $Cursor.Decoder.GetChars($bytes, 0, $count, $characters, 0, $false)
      if ($characterCount -gt 0) {
        & $OnOutput (-join $characters[0..($characterCount - 1)])
      }
    }
  } catch [IO.FileNotFoundException] {
    # The launcher can replace its redirected output files between reads.
  } finally {
    if ($file) { $file.Dispose() }
  }
}
