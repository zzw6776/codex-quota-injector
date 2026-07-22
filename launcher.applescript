on run
	set appPath to POSIX path of (path to me)
	set projectDir to do shell script "/usr/bin/dirname " & quoted form of appPath
	set launcherPath to projectDir & "/start-codex-quota.command"

	try
		do shell script "/bin/zsh " & quoted form of launcherPath
	on error errorMessage number errorNumber
		display dialog "Codex 额度悬浮框启动失败（" & errorNumber & "）" & return & return & errorMessage buttons {"确定"} default button "确定" with icon stop
	end try
end run
