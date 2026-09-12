Unicode True
RequestExecutionLevel user
!include LogicLib.nsh

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef INPUT_EXE
  !error "INPUT_EXE is required"
!endif
!ifndef WINDOWS_RELAY_EXE
  !error "WINDOWS_RELAY_EXE is required"
!endif
!ifndef WSL_RELAY_EXE
  !error "WSL_RELAY_EXE is required"
!endif
!ifndef APP_ICON
  !error "APP_ICON is required"
!endif
!ifndef NODE_LICENSE
  !error "NODE_LICENSE is required"
!endif
!ifndef OUTPUT_EXE
  !error "OUTPUT_EXE is required"
!endif

Name "Codex Quota Injector"
OutFile "${OUTPUT_EXE}"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
InstallDir "$LOCALAPPDATA\Programs\Codex Quota Injector"
InstallDirRegKey HKCU "Software\Codex Quota Injector" "InstallDir"
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=Codex Quota Injector update.exe" "${INPUT_EXE}"
  ExecWait '"$PLUGINSDIR\Codex Quota Injector update.exe" --prepare-update' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "无法安全关闭正在运行的 Codex Quota Injector 或 Codex，安装已取消。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetOutPath "$INSTDIR"
  File "/oname=Codex Quota Injector.exe" "${INPUT_EXE}"
  File "/oname=NODE_LICENSE.txt" "${NODE_LICENSE}"
  Delete "$INSTDIR\relay\codex-quota-relay-windows-*"
  Delete "$INSTDIR\relay\codex-quota-relay-wsl-*"
  SetOutPath "$INSTDIR\relay"
  File "/oname=codex-quota-relay-windows-${VERSION}.exe" "${WINDOWS_RELAY_EXE}"
  File "/oname=codex-quota-relay-wsl-${VERSION}" "${WSL_RELAY_EXE}"
  SetOutPath "$INSTDIR"

  WriteRegStr HKCU "Software\Codex Quota Injector" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector" "DisplayName" "Codex Quota Injector"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\Codex Quota Injector"
  CreateShortCut "$SMPROGRAMS\Codex Quota Injector\Codex Quota Injector.lnk" "$INSTDIR\Codex Quota Injector.exe"
  CreateShortCut "$DESKTOP\Codex Quota Injector.lnk" "$INSTDIR\Codex Quota Injector.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Codex Quota Injector.lnk"
  Delete "$SMPROGRAMS\Codex Quota Injector\Codex Quota Injector.lnk"
  RMDir "$SMPROGRAMS\Codex Quota Injector"
  Delete "$INSTDIR\Codex Quota Injector.exe"
  Delete "$INSTDIR\NODE_LICENSE.txt"
  Delete "$INSTDIR\relay\codex-quota-relay-windows-*"
  Delete "$INSTDIR\relay\codex-quota-relay-wsl-*"
  RMDir "$INSTDIR\relay"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Codex Quota Injector"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector"
SectionEnd
