' Launch Agent Island detached, with no console window.
'
' `npm run dev` ties the app to the shell that started it, so the island dies
' whenever that shell goes away — which is what kept happening when it was
' started from a tool session. This starts the built app directly from the
' Electron binary instead, with no parent process to outlive.
'
' Requires `npm run build` first: the main process falls back to loading
' out/renderer/index.html when no dev server URL is set, so out/ must exist.
'
' The app takes a single-instance lock, so running this while another copy is
' up simply exits rather than opening a second island.

Option Explicit

Dim shell, fso, root, electron, quoted
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' scripts/start-island.vbs -> repository root
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
electron = fso.BuildPath(root, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electron) Then
  MsgBox "Electron not found at:" & vbCrLf & electron & vbCrLf & vbCrLf & _
         "Run 'npm install' in the repository first.", 16, "Agent Island"
  WScript.Quit 1
End If

If Not fso.FileExists(fso.BuildPath(root, "out\main\index.js")) Then
  MsgBox "No build found." & vbCrLf & vbCrLf & _
         "Run 'npm run build' in the repository first.", 16, "Agent Island"
  WScript.Quit 1
End If

shell.CurrentDirectory = root
quoted = """" & electron & """ """ & root & """"

' 0 = hidden window (no console flash), False = do not wait for it to exit.
shell.Run quoted, 0, False
