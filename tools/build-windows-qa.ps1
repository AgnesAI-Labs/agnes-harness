[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$NodeLicense
)
$ErrorActionPreference = 'Stop'
$qaRepo = Split-Path $PSScriptRoot -Parent
$qaOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $qaOutput) { throw '输出目录已存在；请指定新的目录，避免覆盖已有测试包。' }
if ((& $NodeExe --version).Trim() -ne 'v24.20.0' -or $LASTEXITCODE -ne 0) { throw '需要 Node 24.20.0。' }
if (!$NodeLicense) { $NodeLicense = Join-Path (Split-Path $NodeExe -Parent) 'LICENSE' }
if (!(Test-Path -LiteralPath $NodeLicense -PathType Leaf)) { throw '请通过 -NodeLicense 提供 Node 24.20.0 发行包的 LICENSE 文件。' }
$qaCommit = (& git -C $qaRepo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $qaCommit -notmatch '^[0-9a-f]{40}$') { throw '无法核对源码提交。' }
if (& git -C $qaRepo status --porcelain --untracked-files=normal) { throw '源码有未提交改动，请先提交并验证后打包。' }
Push-Location -LiteralPath $qaRepo
try {
    & $NodeExe (Join-Path $qaRepo 'tools\toolchain\run.mjs') --filter @agnes/cli build:local --output-dir (Join-Path $qaOutput 'runtime')
    if ($LASTEXITCODE -ne 0) { throw '构建失败，不能交付当前目录。' }
    Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $qaOutput 'node.exe')
    Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $qaOutput 'NODE-LICENSE.txt')
    foreach ($name in @('start-windows-qa.ps1', 'start-windows-qa.cmd', 'LICENSE', 'NOTICE')) {
        Copy-Item -LiteralPath (Join-Path $qaRepo $name) -Destination (Join-Path $qaOutput $name)
    }
    Copy-Item -LiteralPath (Join-Path $qaRepo 'docs\guide\windows-cloud-qa.zh-CN.md') -Destination (Join-Path $qaOutput 'README-QA.md')
    $qaHashes = [ordered]@{}
    $qaHashes['node.exe'] = (Get-FileHash -LiteralPath (Join-Path $qaOutput 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $qaOutput 'runtime') -Recurse -File | Sort-Object FullName) {
        $name = $file.FullName.Substring($qaOutput.TrimEnd('\').Length + 1).Replace('\', '/')
        $qaHashes[$name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [ordered]@{ source_commit = $qaCommit; node_version = '24.20.0'; built_utc = [DateTime]::UtcNow.ToString('o'); files = $qaHashes } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $qaOutput 'qa-build.json') -Encoding UTF8
    & (Join-Path $qaOutput 'start-windows-qa.ps1') -CheckOnly
    Write-Host "测试包已生成：$qaOutput。可完整压缩后交付，不包含 Key 或用户数据。"
}
finally { Pop-Location }
