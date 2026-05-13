!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing running DiVault processes before upgrade..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @(''divault_desktop.exe'', ''DiVault.exe'') -or ($_.Name -eq ''php.exe'' -and $_.ExecutablePath -like ''*\DiVault\resources\php\*'') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing running DiVault processes before uninstall..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @(''divault_desktop.exe'', ''DiVault.exe'') -or ($_.Name -eq ''php.exe'' -and $_.ExecutablePath -like ''*\DiVault\resources\php\*'') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 1500
!macroend
