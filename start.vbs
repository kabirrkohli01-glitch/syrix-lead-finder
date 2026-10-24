' SYRIX Lead Finder - the launcher behind the desktop shortcut.
'
' Starts server.js with no console window, from this folder, using the Node
' on the PATH. The server opens the browser itself once it is listening, so
' the page never loads before the server is ready. If the app is already
' running, the server simply brings the page up again.

Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

On Error Resume Next
shell.Run "node """ & here & "\server.js""", 0, False

If Err.Number <> 0 Then
  MsgBox "SYRIX Lead Finder could not start." & vbCrLf & vbCrLf & _
         "It needs Node.js, which does not appear to be installed or is not on the PATH." & vbCrLf & _
         "Install it free from nodejs.org and try again." & vbCrLf & vbCrLf & _
         "Error: " & Err.Description, _
         vbExclamation, "SYRIX Lead Finder"
End If
