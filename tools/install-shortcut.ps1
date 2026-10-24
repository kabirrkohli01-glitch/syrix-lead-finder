# Creates the "SYRIX Lead Finder" shortcut on the desktop.
# Run: powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1

$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'SYRIX Lead Finder.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $root 'start.vbs') + '"'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = (Join-Path $root 'web\assets\syrix-lead-finder.ico') + ',0'
$shortcut.Description = 'Find organisations and people with an evidenced need for a consultancy'
$shortcut.Save()

Write-Output "Created $link"
