param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction Stop
$launcherPath = Join-Path $PSScriptRoot 'scripts/start-local.mjs'
$launchArguments = @($launcherPath)
if ($Foreground) { $launchArguments += '--foreground' }
& $nodeCommand.Source @launchArguments
exit $LASTEXITCODE
