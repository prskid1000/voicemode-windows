Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = fso.BuildPath(appDir, "node_modules\electron\dist\electron.exe")
mainJs = fso.BuildPath(appDir, "dist\main\main\index.js")

WshShell.CurrentDirectory = appDir
WshShell.Run """" & electronExe & """ """ & mainJs & """", 1, False
