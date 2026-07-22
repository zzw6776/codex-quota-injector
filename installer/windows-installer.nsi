Unicode True
RequestExecutionLevel user

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef INPUT_EXE
  !error "INPUT_EXE is required"
!endif
!ifndef NODE_LICENSE
  !error "NODE_LICENSE is required"
!endif
!ifndef OUTPUT_EXE
  !error "OUTPUT_EXE is required"
!endif

Name "Codex Quota Injector"
OutFile "${OUTPUT_EXE}"
InstallDir "$LOCALAPPDATA\Programs\Codex Quota Injector"
InstallDirRegKey HKCU "Software\Codex Quota Injector" "InstallDir"
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /oname="Codex Quota Injector.exe" "${INPUT_EXE}"
  File /oname="NODE_LICENSE.txt" "${NODE_LICENSE}"

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
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Codex Quota Injector"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Quota Injector"
SectionEnd
