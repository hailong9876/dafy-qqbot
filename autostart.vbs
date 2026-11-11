Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim NODE
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  NODE = "C:\Program Files\nodejs\node.exe"
ElseIf fso.FileExists("D:\Program Files\nodejs\node.exe") Then
  NODE = "D:\Program Files\nodejs\node.exe"
ElseIf fso.FileExists(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe")) Then
  NODE = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe")
Else
  NODE = "node"
End If

Dim ROOT
ROOT = fso.GetParentFolderName(WScript.ScriptFullName)

sh.CurrentDirectory = ROOT
sh.Run """" & NODE & """ """ & ROOT & "\keep_alive.js""", 0, False

sh.CurrentDirectory = ROOT & "\video-server"
sh.Run """" & NODE & """ """ & ROOT & "\video-server\server.js""", 0, False
