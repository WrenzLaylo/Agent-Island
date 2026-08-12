; Extra uninstall steps for the NSIS installer.
;
; The app registers its own start-at-login entry rather than letting the
; installer do it, so that the tray toggle stays the single source of truth
; (see src/main/login-item.ts). The consequence is that NSIS knows nothing
; about that entry and leaves it behind on uninstall, pointing at an
; executable that no longer exists.
;
; Windows then fails to start it at every login, silently. Verified by
; installing and uninstalling a real build: the directory went, the Run value
; stayed.

!macro customUnInstall
  ; The value name Electron derives from the AppUserModelId of a packaged
  ; build, e.g. "electron.app.Agent Island".
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${PRODUCT_NAME}"

  ; Windows mirrors every Run entry here to remember whether the user disabled
  ; it in Task Manager. Leaving this behind makes the app reappear in the
  ; Startup list as a disabled item long after it is gone.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.${PRODUCT_NAME}"
!macroend
