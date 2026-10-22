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
    @('UNC AGH_HOME', '\\server\share\agh', $null, [IO.Path]::Combine('\\server\share\agh', 'data')),
    @('HOME over USERPROFILE', $null, $null, [IO.Path]::Combine('D:\HomeDir', '.agh\data'), 'D:\HomeDir')
)
foreach ($case in $homes) {
    $actual = Resolve-LocalDataDir -AghHome $case[1] -AgnesHome $case[2] -OsHome $case[4] -UserProfile $profileDir
    if ($actual -ne $case[3]) { throw "Failed: $($case[0]) resolved $actual" }
}
$refusals = 0
foreach ($current in @($null, ' ', 'D:\AghData')) {
    $refused = $false
    try { $null = Resolve-LocalDataDir -AghHome $current -AgnesHome 'D:\AgnesData' -UserProfile $profileDir }
    catch {
        if ($_.Exception.Message -notmatch 'AGNES_HOME.*clean home') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'Retired AGNES_HOME was accepted' }
    $refusals++
}
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
$cases = @(
    @('scoped daemon', $daemon, 'daemon', $true),
    @('scoped web', $web, 'web', $true),
    @('unquoted arguments', $daemon.Replace('"' + $repoDir + '"', $repoDir), 'daemon', $true),
    @('another profile', $daemon.Replace('local-dev --workspace', 'other --workspace'), 'daemon', $false),
    @('another data directory', $daemon.Replace($dataDir, $dataDir + '-other'), 'daemon', $false),
    @('another workspace', $daemon.Replace('--workspace "' + $repoDir + '"', '--workspace "D:\other"'), 'daemon', $false),
    @('another build root', $daemon.Replace('\packages\cli\dist\', '\packages\cli\dist-other\'), 'daemon', $false),
    @('path traversal', $daemon.Replace('\dist\local-dev-old\', '\dist\..\outside\'), 'daemon', $false),
    @('duplicate profile', $daemon + ' --profile local-dev', 'daemon', $false),
    @('missing data', $daemon.Substring(0, $daemon.IndexOf(' --data-dir')), 'daemon', $false),
    @('other port', $web.Replace('4180', '4181'), 'web', $false),
    @('worker', $daemon.Replace('daemon.mjs', 'worker.mjs'), 'daemon', $false),
    @('unknown argument', $daemon + ' --home C:\other', 'daemon', $false),
    @('malformed quotes', $daemon + ' "', 'daemon', $false)
)
foreach ($case in $cases) {
    $actual = Test-LocalAgnesProcess ([pscustomobject]@{ Name = 'node.exe'; CommandLine = $case[1] }) $case[2]
    if ($actual -ne $case[3]) { throw "Failed: $($case[0])" }
}
if (Test-LocalAgnesProcess ([pscustomobject]@{ Name = 'other.exe'; CommandLine = $daemon }) 'daemon') { throw 'Wrong executable accepted' }
if (Test-LocalAgnesProcess $null 'daemon') { throw 'Missing process accepted' }
Write-Host "$($cases.Count + 2) process identity checks passed; script syntax passed."

# Exercise orchestration without building, launching or stopping real processes.
$pin = (Get-Content -LiteralPath (Join-Path $repoDir '.node-version') -Raw).Trim()
$nodeVersion = "v$pin"
$miseVersion = "v$pin"
$miseCalls = @{ count = 0 }
$launchCalls = [Collections.Generic.List[object]]::new()
$failBuild = $false
$failToolchain = $false
$occupied = $false
function node {
    if ($args[0] -ne '-p') { throw 'An unselected Node runtime was invoked' }
    $global:LASTEXITCODE = 0
    @{ version = $nodeVersion; execPath = 'selected-node' } | ConvertTo-Json -Compress
}
function mise {
    $miseCalls.count++
    $global:LASTEXITCODE = 0
    @{ version = $miseVersion; execPath = 'selected-node' } | ConvertTo-Json -Compress
}
function selected-node {
    $global:LASTEXITCODE = 0
    if ($args.Count -eq 1 -and $args[0] -eq (Join-Path $repoDir 'tools\toolchain\run.mjs')) {
        $global:LASTEXITCODE = [int]$failToolchain
        return
    }
    $launchCalls.Add(@($args))
    if ($args -contains 'build:local') { $global:LASTEXITCODE = [int]$failBuild }
}
function Test-Path {
    param($LiteralPath, $PathType)
    return $true
}
function Get-NetTCPConnection {
    param($LocalPort, $State, $ErrorAction)
    if ($occupied) { [pscustomobject]@{ OwningProcess = 12345 } }
}
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($occupied) { [pscustomobject]@{ Name = 'other.exe'; CommandLine = 'other'; ProcessId = 12345 } }
}
& (Join-Path $repoDir 'start-local-windows.ps1') *> $null
if ($miseCalls.count -ne 0 -or $launchCalls.Count -ne 3 -or
    $launchCalls[0][0] -ne (Join-Path $repoDir 'tools\toolchain\run.mjs') -or
    $launchCalls[0] -notcontains 'build:local' -or $launchCalls[1] -notcontains 'stop' -or
    $launchCalls[2] -notcontains 'serve' -or $launchCalls[2] -contains '--import') {
    throw 'Build, stop and packaged launch must use the selected Node in the existing order'
}
$outputIndex = [Array]::IndexOf($launchCalls[0], '--output-dir')
if ($outputIndex -lt 0 -or $launchCalls[0][$outputIndex + 1] -notmatch 'local-dev-\d{8}-\d{9}$') {
    throw 'Local builds must retain their independent output directories'
}
$launchCalls.Clear()
$nodeVersion = 'v0.0.0'
& (Join-Path $repoDir 'start-local-windows.ps1') *> $null
if ($miseCalls.count -ne 1 -or $launchCalls.Count -ne 3) { throw 'A stale Node must use the pinned mise runtime' }
$launchCalls.Clear()
$miseVersion = 'v0.0.0'
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') *> $null } catch { $refused = $_.Exception.Message -like 'Could not select Node*' }
if (-not $refused -or $launchCalls.Count -ne 0) { throw 'Runtime mismatch must prevent build, stop and launch' }
$miseVersion = "v$pin"
$failToolchain = $true
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') *> $null } catch { $refused = $_.Exception.Message -like 'Toolchain check failed*' }
if (-not $refused -or $launchCalls.Count -ne 0) { throw 'Toolchain failure must preserve the existing server' }
$failToolchain = $false
$failBuild = $true
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') *> $null } catch { $refused = $_.Exception.Message -like 'Build failed.*' }
if (-not $refused -or $launchCalls.Count -ne 1) { throw 'Build failure must prevent stop and launch' }
$failBuild = $false
$launchCalls.Clear()
$occupied = $true
$refused = $false
try { & (Join-Path $repoDir 'start-local-windows.ps1') *> $null } catch { $refused = $_.Exception.Message -like 'Port 4180 belongs to another application*' }
if (-not $refused -or $launchCalls.Count -ne 1) { throw 'A foreign port owner must prevent stop and launch' }
Write-Host '6 pinned-runtime and packaged startup checks passed.'
