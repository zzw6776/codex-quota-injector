export const WINDOWS_UPDATE_WINDOW = `param([string]$Url)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form=New-Object System.Windows.Forms.Form
$form.Text='Codex Quota Injector 更新'
$form.ClientSize=New-Object System.Drawing.Size(500,510)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$browser=New-Object System.Windows.Forms.WebBrowser
$browser.Dock='Fill'
$browser.ScriptErrorsSuppressed=$true
$browser.AllowWebBrowserDrop=$false
$form.Controls.Add($browser)
$base=$Url.TrimEnd('/')
$browser.Navigate($Url)
$form.Add_FormClosing({
  param($sender,$eventArgs)
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
