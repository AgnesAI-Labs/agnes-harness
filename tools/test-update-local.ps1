$ErrorActionPreference = 'Stop'
$repoDir = Split-Path $PSScriptRoot -Parent
$errors = $null
$tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repoDir 'update-local.ps1'), [ref]$tokens, [ref]$errors)
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
