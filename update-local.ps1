# Local-only helper: build, stop the old local server, and run the new build.
# Run from PowerShell: .\update-local.ps1
# Old builds and conversation data are retained. No git operations are performed.

$ErrorActionPreference = 'Stop'
$repoDir = $PSScriptRoot

# Same order as @agnes/host agnesHome(): AGH_HOME, then the deprecated AGNES_HOME, then HOME\.agh,
# then %USERPROFILE%\.agh (os.homedir() on Windows). The data directory is passed explicitly below,
# so it must not name a different root than the CLI resolves for the same environment.
function Resolve-LocalDataDir([string]$AghHome, [string]$AgnesHome, [string]$OsHome, [string]$UserProfile) {
    $name = 'AGH_HOME'
    $root = $AghHome
    $data = 'data'
    if (-not $root -or -not $root.Trim()) { $name = 'AGNES_HOME'; $root = $AgnesHome }
    if (-not $root -or -not $root.Trim()) { $name = 'HOME'; $root = $OsHome; $data = '.agh\data' }
    if (-not $root -or -not $root.Trim()) { return [IO.Path]::Combine($UserProfile, '.agh\data') }
    if ($root -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)') {
        throw "$name must be a fully qualified absolute path, got '$root'."
    }
    return [IO.Path]::Combine($root, $data)
}

$dataDir = Resolve-LocalDataDir -AghHome $env:AGH_HOME -AgnesHome $env:AGNES_HOME -OsHome $env:HOME -UserProfile $env:USERPROFILE
$outputDir = Join-Path $repoDir (
    'packages\cli\dist\local-dev-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff')
)
$entry = Join-Path $outputDir 'agnes.mjs'

# Fail closed: only the exact launcher grammar and this repository's build outputs qualify.
function Test-LocalAgnesProcess($ProcessInfo, [string]$Kind) {
    if ($null -eq $ProcessInfo -or $ProcessInfo.Name -ne 'node.exe') { return $false }
    $command = $ProcessInfo.CommandLine
    if (-not $command -or $command -notmatch '^\s*(?:"[^"]*"|[^\s"]+)(?:\s+(?:"[^"]*"|[^\s"]+))*\s*$') { return $false }
    $tokens = @([regex]::Matches($command, '"([^"]*)"|([^\s"]+)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
    if ($tokens.Count -lt 3) { return $false }
    try {
        $buildEntry = [IO.Path]::GetFullPath($tokens[1])
        $distRoot = [IO.Path]::GetFullPath((Join-Path $repoDir 'packages\cli\dist')) + '\'
        if (-not [IO.Path]::IsPathRooted($tokens[1]) -or
            -not $buildEntry.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $index = 2
        if ($Kind -eq 'web') {
            if ([IO.Path]::GetFileName($buildEntry) -ne 'agnes.mjs' -or $tokens[2] -ne 'serve') { return $false }
            $index = 3
        } else {
            if ([IO.Path]::GetFileName($buildEntry) -ne 'daemon.mjs') { return $false }
        }
        $flags = @{}
        for (; $index -lt $tokens.Count; $index += 2) {
            $flag = $tokens[$index]
            if ($flag -notin @('--profile', '--workspace', '--cwd', '--data-dir', '--port', '--local-web-addr', '--local-web-origin') -or
                $flags.ContainsKey($flag) -or $index + 1 -ge $tokens.Count) { return $false }
            $flags[$flag] = $tokens[$index + 1]
        }
        $workspaceFlag = if ($Kind -eq 'web') { '--cwd' } else { '--workspace' }
        if ($flags['--profile'] -cne 'local-dev' -or -not $flags['--data-dir'] -or -not $flags[$workspaceFlag]) { return $false }
        if (-not [IO.Path]::IsPathRooted($flags['--data-dir']) -or -not [IO.Path]::IsPathRooted($flags[$workspaceFlag])) { return $false }
        if ([IO.Path]::GetFullPath($flags['--data-dir']).TrimEnd('\') -ne [IO.Path]::GetFullPath($dataDir).TrimEnd('\') -or
            [IO.Path]::GetFullPath($flags[$workspaceFlag]).TrimEnd('\') -ne [IO.Path]::GetFullPath($repoDir).TrimEnd('\')) { return $false }
        return ($Kind -ne 'web' -or $flags['--port'] -eq '4180')
    } catch { return $false }
}

function Stop-VerifiedLocalProcess($Candidate, [string]$Kind) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($Candidate.ProcessId)"
    if ($null -eq $current) { return }
    if ($current.CreationDate -ne $Candidate.CreationDate -or -not (Test-LocalAgnesProcess $current $Kind)) {
        throw "Process identity changed (PID $($Candidate.ProcessId)); refusing to stop it."
    }
    $handle = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $handle) { return }
    # Bind termination to the process instance, not a PID that could subsequently be reused.
    $null = $handle.Handle
    if ($handle.StartTime.ToUniversalTime().Ticks -ne $current.CreationDate.ToUniversalTime().Ticks) {
        # CIM timestamps have microsecond precision; compare at that precision.
        if ([Math]::Abs(($handle.StartTime - $current.CreationDate).TotalMilliseconds) -ge 1) {
            throw "Process start time changed (PID $($current.ProcessId)); refusing to stop it."
        }
    }
    Write-Host "Stopping old Agnes $Kind (PID $($current.ProcessId))..."
    $handle | Stop-Process -Force
    if (-not $handle.WaitForExit(10000)) { throw "Old Agnes $Kind did not exit within 10 seconds." }
}

Push-Location -LiteralPath $repoDir
try {
    Write-Host '[1/4] Building the current local code...'
    & pnpm --filter @agnes/cli build:local --output-dir $outputDir
    if ($LASTEXITCODE -ne 0) {
        throw 'Build failed. The existing server has not been stopped.'
    }
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw 'Build output is missing. The existing server has not been stopped.'
    }

    Write-Host '[2/4] Checking the existing server on port 4180...'
    $listeners = @(Get-NetTCPConnection -LocalPort 4180 -State Listen -ErrorAction SilentlyContinue)
    $processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($processId in $processIds) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
        if (-not (Test-LocalAgnesProcess $processInfo 'web')) {
            throw "Port 4180 belongs to another application (PID $processId). Nothing was stopped."
        }
    }
    Write-Host '[3/4] Stopping the old daemon and cleaning verified local leftovers...'
    & node $entry daemon stop --profile local-dev --workspace $repoDir --data-dir $dataDir
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Normal daemon stop failed; checking for verified local leftovers.'
    }
    foreach ($kind in @('daemon', 'web')) {
        $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
            Test-LocalAgnesProcess $_ $kind
        })
        foreach ($candidate in $candidates) { Stop-VerifiedLocalProcess $candidate $kind }
    }
    if (@(Get-NetTCPConnection -LocalPort 4180 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Port 4180 is still occupied. The new server was not started.'
    }

    Write-Host '[4/4] Starting the new build. Keep this terminal open.'
    Write-Host 'Open the FULL new URL printed below. Re-running this script replaces this local instance.'
    & node $entry serve --port 4180 --profile local-dev --cwd $repoDir --data-dir $dataDir
    if ($LASTEXITCODE -ne 0) {
        throw 'The web server exited with an error. See the output above.'
    }
} finally {
    Pop-Location
}
