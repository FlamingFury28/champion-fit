$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'start_champion_fit.ps1'
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'Champion Fit.lnk'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Script di avvio non trovato: $launcher"
}
if (-not (Test-Path -LiteralPath $powershell)) {
    throw "Windows PowerShell non trovato: $powershell"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershell
$shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$shortcut.WorkingDirectory = $appRoot
$shortcut.Description = 'Avvia Champion Fit e apre la dashboard locale in Firefox.'
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Output "Avvio automatico configurato per l'utente corrente: $shortcutPath"
Write-Output 'Avvio Champion Fit ora per controllare il server e aprire la dashboard.'
& $launcher
