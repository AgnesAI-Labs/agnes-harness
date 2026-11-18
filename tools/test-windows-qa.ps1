param([Parameter(Mandatory = $true)][string]$NodeExe)
$ErrorActionPreference = 'Stop'
$qaLauncher = Join-Path (Split-Path $PSScriptRoot -Parent) 'start-windows-qa.ps1'
$qaTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('agh-launch-check-' + [Guid]::NewGuid().ToString('N'))
$qaPackage = Join-Path $qaTestRoot 'package'
New-Item -ItemType Directory -Path (Join-Path $qaPackage 'runtime') -Force | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $qaPackage 'node.exe')
$qaCommit = 'a' * 40
$qaFiles = [ordered]@{}
foreach ($name in @('agnes-main.mjs', 'daemon-main.mjs', 'worker-main.mjs')) {
    '/* launcher fixture */' | Set-Content -LiteralPath (Join-Path $qaPackage "runtime\$name") -Encoding ASCII
    $qaFiles["runtime/$name"] = (Get-FileHash -LiteralPath (Join-Path $qaPackage "runtime\$name")).Hash
}
$qaFiles['node.exe'] = (Get-FileHash -LiteralPath (Join-Path $qaPackage 'node.exe')).Hash
$qaManifest = @{ source_commit = $qaCommit; node_version = '24.20.0'; files = $qaFiles }
$qaManifestPath = Join-Path $qaPackage 'qa-build.json'
$qaManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $qaManifestPath -Encoding UTF8
& $qaLauncher -PackageDirectory $qaPackage -CheckOnly

$qaChecks = 1
function Assert-QaRefusal([scriptblock]$Action, [string]$Expected) {
    $qaRejected = $false
    try { & $Action *> $null } catch { $qaRejected = $_.Exception.Message -like "*$Expected*" }
    if (!$qaRejected) { throw "Expected refusal: $Expected" }
    $script:qaChecks++
}
Assert-QaRefusal { & $qaLauncher -PackageDirectory $qaTestRoot -CheckOnly } 'qa-build.json'
'changed' | Add-Content -LiteralPath (Join-Path $qaPackage 'runtime\worker-main.mjs') -Encoding ASCII
Assert-QaRefusal { & $qaLauncher -PackageDirectory $qaPackage -CheckOnly } 'worker-main.mjs'
'/* launcher fixture */' | Set-Content -LiteralPath (Join-Path $qaPackage 'runtime\worker-main.mjs') -Encoding ASCII
$qaData = Join-Path $qaTestRoot 'existing-data'
New-Item -ItemType Directory -Path $qaData | Out-Null
$qaSentinel = Join-Path $qaData 'keep.txt'
'preserve user files' | Set-Content -LiteralPath $qaSentinel -Encoding ASCII
$qaBefore = (Get-FileHash -LiteralPath $qaSentinel).Hash
Assert-QaRefusal { & $qaLauncher -PackageDirectory $qaPackage -DataRoot $qaData } '没有测试版本标识'
@{ source_commit = 'b' * 40 } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $qaData 'qa-environment.json') -Encoding UTF8
Assert-QaRefusal { & $qaLauncher -PackageDirectory $qaPackage -DataRoot $qaData } '属于其他版本'
Assert-QaRefusal { & $qaLauncher -PackageDirectory $qaPackage -DataRoot 'relative-data' } '完整绝对路径'
if ((Get-FileHash -LiteralPath $qaSentinel).Hash -ne $qaBefore) { throw 'User data was modified' }
$qaSocket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
try {
    $qaSocket.Start()
    $qaPort = $qaSocket.LocalEndpoint.Port
    $qaNewData = Join-Path $qaTestRoot 'new-data'
    Assert-QaRefusal { & $qaLauncher -PackageDirectory $qaPackage -DataRoot $qaNewData -Port $qaPort } '端口已占用'
    if (Test-Path -LiteralPath $qaNewData) { throw 'Port refusal wrote a new environment' }
} finally { $qaSocket.Stop() }
Write-Host "$qaChecks Windows launcher checks passed. Fixture retained at $qaTestRoot"
