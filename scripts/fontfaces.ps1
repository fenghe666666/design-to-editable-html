param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$installed = New-Object System.Drawing.Text.InstalledFontCollection
$names = [string[]]@($installed.Families | ForEach-Object { $_.Name })
[System.IO.File]::WriteAllLines($Out, $names, (New-Object System.Text.UTF8Encoding($false)))
