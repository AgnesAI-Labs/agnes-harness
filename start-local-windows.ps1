# Local development: prepare the backend, watch frontend sources, and refresh connected pages.
# Run from PowerShell: .\start-local-windows.ps1
# Conversation data is retained. Backend edits require rerunning this script. No git operations.

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
$outputDir = Join-Path $repoDir 'packages\cli\dist\local'
$entry = Join-Path $outputDir 'agnes.mjs'
$devEntry = Join-Path $repoDir 'packages\cli\tools\web-local.ts'

# Select one executable for stop, build and launch without changing the user's PATH.
function Resolve-LocalNode {
    $pin = (Get-Content -LiteralPath (Join-Path $repoDir '.node-version') -Raw).Trim()
    $probe = 'JSON.stringify({version:process.version,execPath:process.execPath})'
    $runtime = $null
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $runtime = (& node -p $probe) | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $runtime.version -ceq "v$pin" -and $runtime.execPath) { return $runtime.execPath }
    }
    if (-not (Get-Command mise -ErrorAction SilentlyContinue)) {
        throw "Node $pin is required. Install mise, then run 'mise install' from this repository. The existing server has not been stopped."
    }
    $runtime = (& mise exec -- node -p $probe) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $runtime.version -cne "v$pin" -or -not $runtime.execPath) {
        throw "Could not select Node $pin. Run 'mise install' from this repository. The existing server has not been stopped."
    }
    return $runtime.execPath
}

# Fail closed: accept only this repository's packaged launchers or exact development command.
function Test-LocalAgnesProcess($ProcessInfo, [string]$Kind) {
    if ($null -eq $ProcessInfo -or $ProcessInfo.Name -ne 'node.exe') { return $false }
    $command = $ProcessInfo.CommandLine
    if (-not $command -or $command -notmatch '^\s*(?:"[^"]*"|[^\s"]+)(?:\s+(?:"[^"]*"|[^\s"]+))*\s*$') { return $false }
    $tokens = @([regex]::Matches($command, '"([^"]*)"|([^\s"]+)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
    if ($tokens.Count -lt 3) { return $false }
    try {
        if ($Kind -eq 'web' -and $tokens.Count -ge 5 -and $tokens[1] -ceq '--import' -and $tokens[2] -ceq 'tsx') {
            $expected = [IO.Path]::GetFullPath((Join-Path $repoDir 'packages\cli\tools\web-local.ts'))
            if (-not [IO.Path]::IsPathRooted($tokens[3]) -or
                [IO.Path]::GetFullPath($tokens[3]) -ne $expected -or $tokens[4] -cne 'serve') { return $false }
            $index = 5
        } else {
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
    Write-Host '[1/5] Checking local dependencies and pinned Node runtime...'
    $nodeExe = Resolve-LocalNode
    $toolchainRunner = Join-Path $repoDir 'tools\toolchain\run.mjs'
    & $nodeExe $toolchainRunner
    if ($LASTEXITCODE -ne 0) {
        throw 'Toolchain check failed. The existing server has not been stopped.'
    }
    Write-Host "Using Node: $nodeExe"
    if (Test-Path -LiteralPath "$outputDir.build-lock") {
        throw 'Backend build output is locked. Inspect packages/cli/dist/local.build-lock using docs/guide/build-recovery.md. The existing server has not been stopped.'
    }
    $tsxCommand = Join-Path $repoDir 'node_modules\.bin\tsx.cmd'
    if (-not (Test-Path -LiteralPath $tsxCommand -PathType Leaf)) {
        & $nodeExe $toolchainRunner install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            throw 'Dependency install failed. The existing server has not been stopped.'
        }
        if (-not (Test-Path -LiteralPath $tsxCommand -PathType Leaf)) {
            throw 'tsx is still missing after install. The existing server has not been stopped.'
        }
    }

    Write-Host '[2/5] Checking the existing server on port 4180...'
    $listeners = @(Get-NetTCPConnection -LocalPort 4180 -State Listen -ErrorAction SilentlyContinue)
    $processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($processId in $processIds) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
        if (-not (Test-LocalAgnesProcess $processInfo 'web')) {
            throw "Port 4180 belongs to another application (PID $processId). Nothing was stopped."
        }
    }
    Write-Host '[3/5] Stopping the old daemon and cleaning verified local leftovers...'
    # Stop the launcher first: while compiling its frontend it may not have spawned the daemon yet.
    # Otherwise it can spawn a new daemon after the stop/discovery pass and leave native DLLs locked.
    $launchers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        Test-LocalAgnesProcess $_ 'web'
    })
    foreach ($launcher in $launchers) { Stop-VerifiedLocalProcess $launcher 'web' }
    if (Test-Path -LiteralPath $entry -PathType Leaf) {
        & $nodeExe $entry daemon stop --profile local-dev --workspace $repoDir --data-dir $dataDir
    } else {
        & $nodeExe --import tsx (Join-Path $repoDir 'packages\cli\src\bin.ts') daemon stop --profile local-dev --workspace $repoDir --data-dir $dataDir
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Normal daemon stop failed; checking for verified local leftovers.'
    }
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        Test-LocalAgnesProcess $_ 'daemon'
    })
    foreach ($candidate in $candidates) { Stop-VerifiedLocalProcess $candidate 'daemon' }
    if (@(Get-NetTCPConnection -LocalPort 4180 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Port 4180 is still occupied. The new server was not started.'
    }

    # Development resolves its composed backend from dist/local. Stop its old processes first:
    # Windows may hold native files open and prevent that directory from being replaced.
    Write-Host '[4/5] Building the development backend...'
    # The source launcher and packaged daemon resolve different copies of system-node.
    # Repair the source copy only when it cannot load under the selected runtime.
    & $nodeExe -e 'try { require(process.argv[1]); } catch { process.exitCode = 1; }' (Join-Path $repoDir 'packages\system-node\dist\native\agnes-system.node')
    if ($LASTEXITCODE -ne 0) {
        & $nodeExe (Join-Path $repoDir 'packages\system-node\scripts\build-native.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Source native build failed. Fix the error and rerun this script.' }
    }
    & $nodeExe $toolchainRunner --filter @agnes/cli build:local --output-dir $outputDir
    if ($LASTEXITCODE -ne 0) {
        throw 'Backend build failed. The old local instance was stopped; fix the error and rerun this script.'
    }
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw 'Backend build output is missing. The development server was not started.'
    }

    Write-Host '[5/5] Starting development mode. Keep this terminal open.'
    Write-Host 'Frontend edits rebuild and refresh automatically. Rerun this script after backend edits.'
    Write-Host 'Open the FULL new URL printed below. Re-running this script replaces this local instance.'
    & $nodeExe --import tsx $devEntry serve --port 4180 --profile local-dev --cwd $repoDir --data-dir $dataDir
    if ($LASTEXITCODE -ne 0) {
        throw 'The web server exited with an error. See the output above.'
    }
} finally {
    Pop-Location
}
