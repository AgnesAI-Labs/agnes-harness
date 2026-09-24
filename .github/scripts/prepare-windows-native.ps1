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
