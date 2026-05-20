!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing running DiVault processes before upgrade..."
  nsExec::ExecToLog 'taskkill /F /T /IM divault_desktop.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM DiVault.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM php.exe'
  Sleep 2500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing running DiVault processes before uninstall..."
  nsExec::ExecToLog 'taskkill /F /T /IM divault_desktop.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM DiVault.exe'
  nsExec::ExecToLog 'taskkill /F /T /IM php.exe'
  Sleep 2500
!macroend
