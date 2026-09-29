# Run a skill script from a writable workspace copy. Node cannot always traverse
# the installed skill directory under CODEX_HOME in the desktop sandbox.
$ErrorActionPreference = 'Stop'

if ($args.Count -lt 1) {
    [Console]::Error.WriteLine('Usage: launch.ps1 run|fill|prepare [script arguments]')
    exit 2
}

$task = [string]$args[0]
if ($task -ne 'prepare' -and $task -notmatch '^[a-z][a-z0-9-]*$') {
    [Console]::Error.WriteLine('Script name must contain only lowercase letters, digits, and hyphens.')
    exit 2
}

$skillRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path (Get-Location).ProviderPath '.codex-skill-runtime\design-to-editable-html'
try {
    foreach ($folder in @('scripts', 'assets')) {
        $source = Join-Path $skillRoot $folder
        $target = Join-Path $cacheRoot $folder
        $null = New-Item -ItemType Directory -Path $target -Force
        Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
        }
    }
} catch {
    [Console]::Error.WriteLine('Cannot prepare skill scripts in the current directory: ' + $_.Exception.Message)
    [Console]::Error.WriteLine('Run this command from a writable project workspace.')
    exit 2
}

if ($task -eq 'prepare') {
    Write-Output $cacheRoot
    exit 0
}

$script = Join-Path (Join-Path $cacheRoot 'scripts') ($task + '.cjs')
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    [Console]::Error.WriteLine('Skill script not found: ' + $task)
    exit 2
}

$forward = @()
if ($args.Count -gt 1) {
    $forward = @($args[1..($args.Count - 1)])
}
& node $script @forward
exit $LASTEXITCODE
