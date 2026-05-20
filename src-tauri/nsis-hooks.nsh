!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing running DiVault processes before upgrade..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$root = $$env:LOCALAPPDATA + ''\DiVault''; Get-CimInstance Win32_Process | Where-Object { $$_.Name -in @(''divault_desktop.exe'', ''DiVault.exe'') -or ($$_.Name -eq ''php.exe'' -and (($$_.ExecutablePath -like ($$root + ''*'')) -or ($$_.CommandLine -like ($$root + ''*'')))) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 2500
  RMDir /r "$INSTDIR\resources\php"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing running DiVault processes before uninstall..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$root = $$env:LOCALAPPDATA + ''\DiVault''; Get-CimInstance Win32_Process | Where-Object { $$_.Name -in @(''divault_desktop.exe'', ''DiVault.exe'') -or ($$_.Name -eq ''php.exe'' -and (($$_.ExecutablePath -like ($$root + ''*'')) -or ($$_.CommandLine -like ($$root + ''*'')))) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 2500
!macroend
