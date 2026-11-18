[CmdletBinding()]
param(
    [string]$PackageDirectory = $PSScriptRoot,
    [ValidateRange(1024, 65535)][int]$Port = 4188,
    [string]$DataRoot,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'

function Read-QaPackage([string]$Directory) {
    $packageRoot = [IO.Path]::GetFullPath($Directory)
    $manifestPath = Join-Path $packageRoot 'qa-build.json'
    if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw '未找到 qa-build.json。请完整解压测试包，或先执行 tools\build-windows-qa.ps1。'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.source_commit -notmatch '^[0-9a-f]{40}$' -or $manifest.node_version -ne '24.20.0') {
        throw '测试包版本信息不完整，停止启动。'
    }
    foreach ($item in $manifest.files.PSObject.Properties) {
        $target = [IO.Path]::GetFullPath((Join-Path $packageRoot $item.Name))
        if (!$target.StartsWith($packageRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw '测试包校验路径越界。'
        }
        if (!(Test-Path -LiteralPath $target -PathType Leaf) -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $item.Value) {
            throw "测试包文件不完整或版本不一致：$($item.Name)。请重新完整解压。"
        }
    }
    $required = @('node.exe', 'runtime/agnes-main.mjs', 'runtime/daemon-main.mjs', 'runtime/worker-main.mjs')
    foreach ($name in $required) {
        if ($null -eq $manifest.files.PSObject.Properties[$name]) { throw "测试包缺少必需校验项：$name" }
    }
    $node = Join-Path $packageRoot 'node.exe'
    if ((& $node --version).Trim() -ne "v$($manifest.node_version)" -or $LASTEXITCODE -ne 0) {
        throw '测试包自带的 Node 版本不匹配。'
    }
    return [pscustomobject]@{ Root = $packageRoot; Manifest = $manifest; Node = $node }
}

$package = Read-QaPackage $PackageDirectory
Write-Host "AGH Windows 测试版本：$($package.Manifest.source_commit)"
if ($CheckOnly) { Write-Host '测试包完整性及 Node 版本检查通过，未启动进程或修改测试数据。'; return }
if (!$DataRoot) { $DataRoot = Join-Path $env:LOCALAPPDATA ('AgnesHarnessQA\' + $package.Manifest.source_commit.Substring(0, 12)) }
if ($DataRoot -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)') {
    throw 'DataRoot 必须是完整绝对路径。'
}
$qaRoot = [IO.Path]::GetFullPath($DataRoot)
$identityFile = Join-Path $qaRoot 'qa-environment.json'
if (Test-Path -LiteralPath $qaRoot) {
    if (!(Test-Path -LiteralPath $identityFile -PathType Leaf)) { throw '已有数据目录没有测试版本标识，请指定新的空目录。' }
    $identity = Get-Content -LiteralPath $identityFile -Raw | ConvertFrom-Json
    if ($identity.source_commit -ne $package.Manifest.source_commit) { throw '已有测试目录属于其他版本；请使用新目录，不自动升级已有数据。' }
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch { throw "本机 $Port 端口已占用，请关闭自己确认的旧测试窗口，或通过 -Port 选择其他端口。" }
finally { $listener.Stop() }
foreach ($folder in @($qaRoot, (Join-Path $qaRoot 'workspace'), (Join-Path $qaRoot 'logs'))) {
    if (!(Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
}
if (!(Test-Path -LiteralPath $identityFile)) {
    @{ source_commit = $package.Manifest.source_commit } | ConvertTo-Json | Set-Content -LiteralPath $identityFile -Encoding UTF8
}
$names = @('AGH_HOME', 'AGNES_HOME', 'AGNES_PROFILE', 'AGNES_LOCALE', 'AGH_LLMSG_API_BASE_URL', 'NODE_OPTIONS')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:AGH_HOME = Join-Path $qaRoot 'home'
    $env:AGNES_HOME = $null
    $env:AGNES_PROFILE = 'local-dev'
    $env:AGNES_LOCALE = 'zh-CN'
    $env:AGH_LLMSG_API_BASE_URL = 'https://api-llmsg-dev.agnes-dev.com'
    $env:NODE_OPTIONS = $null
    Write-Host "页面：http://127.0.0.1:$Port/（服务就绪后打开）"
    Write-Host "独立数据目录：$qaRoot"
    Write-Host '首次使用：在设置中添加 AGH 通用凭证，再到高级设置选择该凭证并保存连接。'
    Write-Host '本机连接 LLMSG 开发环境。Key 由负责人单独提供，本脚本不保存或内置 Key。'
    Write-Host '保持本窗口运行；Ctrl+C 结束前台服务。不覆盖已有 AGH 安装，不结束其他进程。'
    $entry = Join-Path $package.Root 'runtime\agnes.mjs'
    $qaLog = Join-Path $qaRoot ('logs\serve-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.log')
    & $package.Node $entry serve --home $env:AGH_HOME --profile local-dev --cwd (Join-Path $qaRoot 'workspace') --port $Port 2>&1 |
        Tee-Object -FilePath $qaLog
    if ($LASTEXITCODE -notin @(0, 130)) { throw "AGH 启动失败或异常退出，请保留日志：$qaLog" }
}
finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
