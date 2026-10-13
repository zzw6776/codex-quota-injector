export const WINDOWS_UPDATE_WINDOW = `param([string]$Url,[string]$SizePath)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form=New-Object System.Windows.Forms.Form
$form.Text='Codex Quota Injector 更新'
$form.ClientSize=New-Object System.Drawing.Size(500,510)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='Sizable'
$form.MinimumSize=New-Object System.Drawing.Size(440,500)
$form.MaximizeBox=$true
if ($SizePath -and (Test-Path -LiteralPath $SizePath)) {
  try {
    $saved=Get-Content -LiteralPath $SizePath -Raw | ConvertFrom-Json
    $savedWidth=[double]$saved.width;$savedHeight=[double]$saved.height
    if ($saved.version -eq 1 -and $savedWidth -gt 0 -and $savedHeight -gt 0 -and
        -not [double]::IsInfinity($savedWidth) -and -not [double]::IsInfinity($savedHeight)) {
      $screen=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
      $frameWidth=$form.Width-$form.ClientSize.Width;$frameHeight=$form.Height-$form.ClientSize.Height
      $width=[int][Math]::Max(420,[Math]::Min($savedWidth,$screen.Width-$frameWidth))
      $height=[int][Math]::Max(460,[Math]::Min($savedHeight,$screen.Height-$frameHeight))
      $form.ClientSize=New-Object System.Drawing.Size($width,$height)
    }
  } catch { Write-Warning "读取窗口大小失败，使用默认大小：$_" }
}
function Save-UpdateWindowSize {
  if (-not $SizePath -or $form.WindowState -ne 'Normal') { return }
  try {
    $content=@{version=1;width=$form.ClientSize.Width;height=$form.ClientSize.Height} | ConvertTo-Json -Compress
    $temporary="$SizePath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary,$content,(New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $SizePath) {[System.IO.File]::Replace($temporary,$SizePath,$null)}
    else {[System.IO.File]::Move($temporary,$SizePath)}
  } catch { Write-Warning "保存窗口大小失败：$_" }
}
$form.Add_ResizeEnd({Save-UpdateWindowSize})
$browser=New-Object System.Windows.Forms.WebBrowser
$browser.Dock='Fill'
$browser.ScriptErrorsSuppressed=$true
$browser.AllowWebBrowserDrop=$false
$form.Controls.Add($browser)
$base=$Url.TrimEnd('/')
$browser.Navigate($Url)
$form.Add_FormClosing({
  param($sender,$eventArgs)
  Save-UpdateWindowSize
  try {
    $request=[System.Net.HttpWebRequest]::Create($base+'/close')
    $request.Method='POST';$request.Timeout=2000;$request.ContentLength=0
    $response=$request.GetResponse();$response.Close()
  } catch { $eventArgs.Cancel=$true }
})
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=1000
$timer.Add_Tick({
  try {
    $client=New-Object System.Net.WebClient
    $value=$client.DownloadString($base+'/focus');$client.Dispose()
    if($value -eq 'show') {$form.WindowState='Normal';$form.Activate()}
  } catch {}
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
$timer.Stop();$timer.Dispose()
`;
