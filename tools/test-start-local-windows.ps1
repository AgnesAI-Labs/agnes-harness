$ErrorActionPreference = 'Stop'
$repoDir = Split-Path $PSScriptRoot -Parent
$errors = $null
$tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repoDir 'start-local-windows.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
$profileDir = 'C:\Users\u'
$homes = @(
    @('default home', $null, $null, [IO.Path]::Combine($profileDir, '.agh\data')),
    @('AGH_HOME', 'D:\AghData', $null, [IO.Path]::Combine('D:\AghData', 'data')),
    @('legacy AGNES_HOME', $null, 'D:\AgnesData', [IO.Path]::Combine('D:\AgnesData', 'data')),
    @('AGH_HOME over AGNES_HOME', 'D:\AghData', 'D:\AgnesData', [IO.Path]::Combine('D:\AghData', 'data')),
    @('blank AGH_HOME', ' ', 'D:\AgnesData', [IO.Path]::Combine('D:\AgnesData', 'data')),
    @('UNC AGH_HOME', '\\server\share\agh', $null, [IO.Path]::Combine('\\server\share\agh', 'data')),
    @('HOME over USERPROFILE', $null, $null, [IO.Path]::Combine('D:\HomeDir', '.agh\data'), 'D:\HomeDir'),
    @('AGNES_HOME over HOME', $null, 'D:\AgnesData', [IO.Path]::Combine('D:\AgnesData', 'data'), 'D:\HomeDir')
)
foreach ($case in $homes) {
    $actual = Resolve-LocalDataDir -AghHome $case[1] -AgnesHome $case[2] -OsHome $case[4] -UserProfile $profileDir
    if ($actual -ne $case[3]) { throw "Failed: $($case[0]) resolved $actual" }
}
$refusals = 0
foreach ($relative in @('relative\home', '\rooted-on-current-drive', 'D:drive-relative')) {
    foreach ($variable in @('AghHome', 'AgnesHome', 'OsHome')) {
        $arguments = @{ AghHome = $null; AgnesHome = $null; OsHome = $null; UserProfile = $profileDir }
        $arguments[$variable] = $relative
        $refused = $false
        try { $null = Resolve-LocalDataDir @arguments } catch { $refused = $true }
        if (-not $refused) { throw "Failed: relative $variable $relative accepted" }
        $refusals++
    }
}
Write-Host "$($homes.Count + $refusals) home resolution checks passed."
$dataDir = Resolve-LocalDataDir -UserProfile $env:USERPROFILE
$daemon = '"C:\Program Files\nodejs\node.exe" "' + $repoDir + '\packages\cli\dist\local-dev-old\daemon.mjs" --profile local-dev --workspace "' + $repoDir + '" --data-dir "' + $dataDir + '"'
$web = $daemon.Replace('daemon.mjs"', 'agnes.mjs" serve').Replace('--workspace', '--cwd') + ' --port 4180'
$dev = '"C:\Program Files\nodejs\node.exe" --import tsx "' + $repoDir + '\packages\cli\tools\web-local.ts" serve --profile local-dev --cwd "' + $repoDir + '" --data-dir "' + $dataDir + '" --port 4180'
$cases = @(
    @('scoped daemon', $daemon, 'daemon', $true),
    @('scoped web', $web, 'web', $true),
    @('development web', $dev, 'web', $true),
    @('development is not a daemon', $dev, 'daemon', $false),
    @('another development entry', $dev.Replace('web-local.ts', 'other.ts'), 'web', $false),
    @('another development repository', $dev.Replace($repoDir, $repoDir + '-other'), 'web', $false),
    @('another import loader', $dev.Replace('--import tsx', '--import other'), 'web', $false),
    @('development on other port', $dev.Replace('4180', '4181'), 'web', $false),
    @('development duplicate profile', ($dev + ' --profile local-dev'), 'web', $false),
    @('development with other data', $dev.Replace($dataDir, $dataDir + '-other'), 'web', $false),
    @('unquoted arguments', $daemon.Replace('"' + $repoDir + '"', $repoDir), 'daemon', $true),
    @('another profile', $daemon.Replace('local-dev --workspace', 'other --workspace'), 'daemon', $false),
    @('another data directory', $daemon.Replace($dataDir, $dataDir + '-other'), 'daemon', $false),
    @('another workspace', $daemon.Replace('--workspace "' + $repoDir + '"', '--workspace "D:\other"'), 'daemon', $false),
    @('another build root', $daemon.Replace('\packages\cli\dist\', '\packages\cli\dist-other\'), 'daemon', $false),
    @('path traversal', $daemon.Replace('\dist\local-dev-old\', '\dist\..\outside\'), 'daemon', $false),
    @('duplicate profile', ($daemon + ' --profile local-dev'), 'daemon', $false),
    @('missing data', $daemon.Substring(0, $daemon.IndexOf(' --data-dir')), 'daemon', $false),
    @('other port', $web.Replace('4180', '4181'), 'web', $false),
    @('worker', $daemon.Replace('daemon.mjs', 'worker.mjs'), 'daemon', $false),
    @('unknown argument', ($daemon + ' --home C:\other'), 'daemon', $false),
    @('malformed quotes', ($daemon + ' "'), 'daemon', $false)
)
foreach ($case in $cases) {
    if ($case.Count -ne 4 -or $case[3] -isnot [bool]) { throw 'Invalid process test case' }
    $actual = Test-LocalAgnesProcess ([pscustomobject]@{ Name = 'node.exe'; CommandLine = $case[1] }) $case[2]
    if ($actual -ne $case[3]) { throw "Failed: $($case[0])" }
}
if (Test-LocalAgnesProcess ([pscustomobject]@{ Name = 'other.exe'; CommandLine = $daemon }) 'daemon') { throw 'Wrong executable accepted' }
if (Test-LocalAgnesProcess $null 'daemon') { throw 'Missing process accepted' }
Write-Host "$($cases.Count + 2) process identity checks passed; script syntax passed."

# Run the orchestration with fake commands: no real server, build, or process is touched.
$launchCalls = [Collections.Generic.List[object]]::new()
$failBuild = $false
$occupied = $false
$launcherState = @{ running = $false }
$webStartedAt = Get-Date
$pin = (Get-Content -LiteralPath (Join-Path $repoDir '.node-version') -Raw).Trim()
$nodeVersion = 'v0.0.0'
$miseVersion = "v$pin"
$miseCalls = @{ count = 0 }
$failToolchain = $false
$failSourceNative = $false
$failNativeBuild = $false
$buildLocked = $false
function mise {
    $miseCalls.count++
    $global:LASTEXITCODE = 0
    @{ version = $miseVersion; execPath = 'node' } | ConvertTo-Json -Compress
}
function node {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '-p') { @{ version = $nodeVersion; execPath = 'node' } | ConvertTo-Json -Compress; return }
    if ($args[0] -eq '-e') { $global:LASTEXITCODE = [int]$failSourceNative; return }
    if ($args.Count -eq 1 -and $args[0] -eq (Join-Path $repoDir 'tools\toolchain\run.mjs')) {
        $global:LASTEXITCODE = [int]$failToolchain; return
    }
    if ($args -contains 'stop' -and $launcherState.running) { throw 'The launcher can spawn a daemon after this stop' }
    $launchCalls.Add(@('node') + $args)
    if ($args -contains 'build:local') { $global:LASTEXITCODE = [int]$failBuild }
    if ($args[0] -eq (Join-Path $repoDir 'packages\system-node\scripts\build-native.mjs')) {
        $global:LASTEXITCODE = [int]$failNativeBuild
    }
}
function Test-Path {
    param($LiteralPath, $PathType)
    if ($LiteralPath -eq (Join-Path $repoDir 'packages\cli\dist\local.build-lock')) { return $buildLocked }
    return $true
}
function Get-NetTCPConnection {
    param($LocalPort, $State, $ErrorAction)
    if ($occupied) { [pscustomobject]@{ OwningProcess = 12345 } }
}
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($occupied) { [pscustomobject]@{ Name = 'other.exe'; CommandLine = 'other'; ProcessId = 12345 } }
    elseif ($launcherState.running) {
        [pscustomobject]@{ Name = 'node.exe'; CommandLine = $dev; ProcessId = 12346; CreationDate = $webStartedAt }
    }
}
function Get-Process {
    param($Id, $ErrorAction)
    $handle = [pscustomobject]@{ Handle = 1; StartTime = $webStartedAt }
    $handle | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Timeout) return $true }
    return $handle
}
function Stop-Process {
    param([Parameter(ValueFromPipeline = $true)] $InputObject, [switch] $Force)
    process { $launcherState.running = $false; $launchCalls.Add(@('stop-web')) }
}
& (Join-Path $repoDir 'start-local-windows.ps1')
if ($launchCalls.Count -ne 3 -or $launchCalls[0] -notcontains 'stop' -or
    $launchCalls[1] -notcontains 'build:local' -or
    $launchCalls[1] -notcontains (Join-Path $repoDir 'packages\cli\dist\local') -or
    ($launchCalls[2][0..2] -join ' ') -ne 'node --import tsx' -or
    $launchCalls[2][3] -ne (Join-Path $repoDir 'packages\cli\tools\web-local.ts') -or
    $launchCalls[2][4] -ne 'serve') { throw 'Incorrect development startup sequence' }
$launchCalls.Clear()
$launcherState.running = $true
& (Join-Path $repoDir 'start-local-windows.ps1')
if ($launcherState.running -or $launchCalls.Count -ne 4 -or $launchCalls[0][0] -ne 'stop-web' -or
    $launchCalls[1] -notcontains 'stop') { throw 'An existing launcher must stop before daemon shutdown' }
$launchCalls.Clear()
$failBuild = $true
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') } catch { $refused = $_.Exception.Message -like 'Backend build failed.*' }
if (-not $refused -or $launchCalls.Count -ne 2) { throw 'Build failure must prevent development startup' }
$launchCalls.Clear()
$occupied = $true
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') } catch { $refused = $_.Exception.Message -like 'Port 4180 belongs to another application*' }
if (-not $refused -or $launchCalls.Count -ne 0) { throw 'Foreign port owner must prevent stop/build/start' }
Write-Host '4 development orchestration checks passed.'

$occupied = $false
$failBuild = $false
$launchCalls.Clear()
$miseCalls.count = 0
$nodeVersion = "v$pin"
& (Join-Path $repoDir 'start-local-windows.ps1')
if ($miseCalls.count -ne 0) { throw 'A matching Node must not require mise' }
$nodeVersion = 'v0.0.0'
$miseCalls.count = 0
$launchCalls.Clear()
& (Join-Path $repoDir 'start-local-windows.ps1')
if ($miseCalls.count -ne 1) { throw 'A stale system Node must select the pinned runtime through mise' }

$launchCalls.Clear()
$miseVersion = 'v0.0.0'
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') } catch { $refused = $_.Exception.Message -like 'Could not select Node*' }
if (-not $refused -or $launchCalls.Count -ne 0) { throw 'Runtime mismatch must prevent stop/build/start' }
$miseVersion = "v$pin"
$failToolchain = $true
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') } catch { $refused = $_.Exception.Message -like 'Toolchain check failed*' }
if (-not $refused -or $launchCalls.Count -ne 0) { throw 'Toolchain failure must preserve the existing server' }
$failToolchain = $false
$failSourceNative = $true
& (Join-Path $repoDir 'start-local-windows.ps1')
if ($launchCalls.Count -ne 4 -or $launchCalls[1][1] -ne (Join-Path $repoDir 'packages\system-node\scripts\build-native.mjs') -or
    $launchCalls[2] -notcontains 'build:local') { throw 'An incompatible source native module must be rebuilt before launch' }
$launchCalls.Clear()
$failNativeBuild = $true
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') } catch { $refused = $_.Exception.Message -like 'Source native build failed*' }
if (-not $refused -or $launchCalls.Count -ne 2) { throw 'Native build failure must prevent backend build and launch' }
$launchCalls.Clear()
$buildLocked = $true
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') } catch { $refused = $_.Exception.Message -like 'Backend build output is locked*' }
if (-not $refused -or $launchCalls.Count -ne 0) { throw 'An existing build lock must prevent stop/build/start' }
Write-Host '7 pinned-runtime, lock and native recovery checks passed.'
