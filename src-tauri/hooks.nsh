!macro NSIS_HOOK_PREUNINSTALL
  System::Call 'Kernel32::SetEnvironmentVariable(t "REALMTOOL_RESOURCES", t "$INSTDIR\app") i .r0'
  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\app\backend\main.mjs" uninstall-helper --quiet'
  Pop $0
  ${If} $0 != 0
    DetailPrint "RealmTool helper restore failed ($0). The app uninstall will continue."
  ${EndIf}
!macroend
