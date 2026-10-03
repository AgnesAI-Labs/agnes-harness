param(
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
)

$ErrorActionPreference = 'Stop'
if ($CacheRoot -match "[\r\n]") { throw 'Header cache path must be a single line' }
$nodeRuntime = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodeRuntime -p 'process.versions.node'
if ($LASTEXITCODE -ne 0) { throw 'Cannot determine Node version' }
$npmDirectory = Split-Path (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeGyp = Join-Path $npmDirectory 'node_modules/npm/node_modules/node-gyp/bin/node-gyp.js'
if (-not (Test-Path -LiteralPath $nodeGyp -PathType Leaf)) {
    throw 'The Node installation must include npm and its bundled node-gyp'
}

# Use the npm-bundled downloader and checksum validation; compilation remains repository-owned.
& $nodeRuntime $nodeGyp install "--target=$nodeVersion" "--devdir=$CacheRoot"
if ($LASTEXITCODE -ne 0) { throw 'Node header/library preparation failed' }
$env:AGNES_NODE_HEADERS = Join-Path ([IO.Path]::GetFullPath($CacheRoot)) $nodeVersion
if ($env:GITHUB_ENV) {
    [IO.File]::AppendAllText($env:GITHUB_ENV, "AGNES_NODE_HEADERS=$env:AGNES_NODE_HEADERS`n", [Text.UTF8Encoding]::new($false))
}

# Standalone Job supervisors use the same installed MSVC/SDK toolchain as node-gyp.
# Import only compiler variables, rather than persisting the entire machine environment.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio C++ tools are required' }
$installation = & $vswhere -utf8 -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Cannot locate Visual Studio C++ tools' }
$setup = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
if ($setup -match '["%!\r\n]') { throw 'Unsupported toolchain path' }
$bridge = Join-Path $CacheRoot 'compiler-env.ps1'
[IO.File]::WriteAllText($bridge, @'
$setup = $args[0]
[Console]::OutputEncoding = [Text.Encoding]::Default
cmd /c "call ""$setup"" -no_logo -arch=x64 >nul && set" |
    Where-Object { $_ -match '^(PATH|INCLUDE|LIB|LIBPATH|VCToolsInstallDir|WindowsSdkDir)=' } |
    Out-File -FilePath $args[1] -Encoding UTF8
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
'@, [Text.UTF8Encoding]::new($false))
$dump = Join-Path $CacheRoot 'compiler-env.txt'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bridge $setup $dump
if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize MSVC environment' }
foreach ($line in [IO.File]::ReadAllLines($dump)) {
    $pair = $line.Split('=', 2)
    if ($pair.Count -ne 2 -or $pair[1] -match "[\r\n]") { throw 'Invalid compiler environment' }
    [Environment]::SetEnvironmentVariable($pair[0], $pair[1], 'Process')
    if ($env:GITHUB_ENV) {
        [IO.File]::AppendAllText($env:GITHUB_ENV, "$line`n", [Text.UTF8Encoding]::new($false))
    }
}
$env:AGNES_WINDOWS_CL = (Get-Command cl.exe -ErrorAction Stop).Source
if ($env:GITHUB_ENV) {
    [IO.File]::AppendAllText($env:GITHUB_ENV, "AGNES_WINDOWS_CL=$env:AGNES_WINDOWS_CL`n", [Text.UTF8Encoding]::new($false))
}
