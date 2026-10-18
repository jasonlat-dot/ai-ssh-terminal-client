; Keep the application logo on the right, as in the standard installer.
; Loaded by Tauri before MUI page macros.
!define MUI_HEADERIMAGE_RIGHT

; The old executable can remain in the tray even after its main window closes.
; It must release SQLite and WebView storage before the new identity migrates it.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "shellpilot-rust-preview.exe" "ShellPilot"
  !insertmacro CheckIfAppIsRunning "shellpilot.exe" "ShellPilot"
!macroend

; Tauri skips creating missing Start menu shortcuts during /UPDATE installs.
; Repair that entry after both regular installation and in-app updates, while
; respecting an explicit /NS (no shortcuts) request and existing shortcuts.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $NoShortcutMode <> 1
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $R9
    !if "${STARTMENUFOLDER}" != ""
      StrCpy $R9 "$SMPROGRAMS\$AppStartMenuFolder"
    !else
      StrCpy $R9 "$SMPROGRAMS"
    !endif
    ${IfNot} ${FileExists} "$R9\${PRODUCTNAME}.lnk"
      CreateDirectory "$R9"
      ClearErrors
      CreateShortcut "$R9\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
      ${IfNot} ${Errors}
        !insertmacro SetLnkAppUserModelId "$R9\${PRODUCTNAME}.lnk"
        ; Notify Explorer that a searchable application entry was added.
        System::Call 'shell32::SHChangeNotify(i 0x00000002, i 0x0005, w "$R9\${PRODUCTNAME}.lnk", p 0)'
      ${Else}
        DetailPrint "Could not create the ${PRODUCTNAME} Start menu shortcut."
      ${EndIf}
    ${EndIf}
    ; Updating a migrated shortcut's target does not update its AppUserModelID.
    ; Refresh only shortcuts owned by this installation, including /UPDATE.
    !insertmacro IsShortcutTarget "$R9\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetLnkAppUserModelId "$R9\${PRODUCTNAME}.lnk"
      System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$R9\${PRODUCTNAME}.lnk", p 0)'
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x0005, w "$DESKTOP\${PRODUCTNAME}.lnk", p 0)'
    ${EndIf}
    Pop $R9
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend
