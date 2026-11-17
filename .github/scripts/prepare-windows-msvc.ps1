$ErrorActionPreference = 'Stop'
$started = [Diagnostics.Stopwatch]::StartNew()
if (-not $env:GITHUB_ENV) { throw 'MSVC preparation requires a GitHub Actions environment file' }

function Invoke-ToolchainCapture {
    param([string]$FilePath, [string]$Arguments, [Text.Encoding]$Encoding)
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
        $process.StartInfo.FileName = $FilePath
        $process.StartInfo.Arguments = $Arguments
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.StandardOutputEncoding = $Encoding
        $process.StartInfo.StandardErrorEncoding = $Encoding
        if (-not $process.Start()) { throw 'Cannot start MSVC preparation tool' }
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $text = $output.GetAwaiter().GetResult()
        [void]$errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "MSVC preparation tool failed with exit code $($process.ExitCode)" }
        return $text
    } finally {
        $process.Dispose()
    }
}

# CL appends implicit compiler arguments; preparation must not carry those into child processes.
Remove-Item Env:CL -ErrorAction SilentlyContinue
$nodeRuntime = (Get-Command node.exe -ErrorAction Stop).Source
$arch = (& $nodeRuntime -p 'process.arch').Trim()
if ($LASTEXITCODE -ne 0 -or $arch -notin @('x64', 'arm64')) { throw 'Unsupported Node architecture for MSVC' }
$programFiles = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)', 'Process')
if (-not $programFiles) { throw 'Cannot locate the Visual Studio installer' }
$vswhere = Join-Path $programFiles 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'Visual Studio discovery tool is missing' }
$install = (Invoke-ToolchainCapture $vswhere '-latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath -utf8' ([Text.UTF8Encoding]::new($false))).Trim()
$setup = Join-Path $install 'Common7/Tools/VsDevCmd.bat'
if (-not $install -or $setup -match '["%!\r\n]' -or -not (Test-Path -LiteralPath $setup -PathType Leaf)) {
    throw 'A supported Visual Studio C++ installation is required'
}
$command = Join-Path $env:SystemRoot 'System32/cmd.exe'
if (-not (Test-Path -LiteralPath $command -PathType Leaf)) { throw 'Windows command interpreter is missing' }
# cmd /u emits the built-in SET output as UTF-16LE. Explicit decoding avoids PS 5/7 code-page differences.
$arguments = '/d /u /s /c "call "{0}" -no_logo -arch={1} >nul && set"' -f $setup, $arch
$env:PATH = (Split-Path -Parent $vswhere) + ';' + $env:PATH
$text = Invoke-ToolchainCapture $command $arguments ([Text.Encoding]::Unicode)
$prepared = @{}
foreach ($line in ($text -split "`r?`n")) {
    $split = $line.IndexOf('=')
    if ($split -gt 0) { $prepared[$line.Substring(0, $split)] = $line.Substring($split + 1) }
}
foreach ($name in @('PATH', 'INCLUDE', 'LIB', 'VCToolsInstallDir')) {
    if ([string]::IsNullOrWhiteSpace($prepared[$name])) { throw "MSVC preparation did not provide $name" }
}
if (-not (Test-Path -LiteralPath $prepared['VCToolsInstallDir'] -PathType Container)) {
    throw 'MSVC tools directory is missing'
}
foreach ($name in @('INCLUDE', 'LIB')) {
    $existing = @($prepared[$name] -split ';' | Where-Object { $_ -and (Test-Path -LiteralPath ($_.Trim('"')) -PathType Container) })
    if ($existing.Count -eq 0) { throw "MSVC $name directories are missing" }
}
$compiler = @($prepared['PATH'] -split ';' | ForEach-Object {
    if ($_.Trim()) {
        $candidate = Join-Path ($_.Trim().Trim('"')) 'cl.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate }
    }
}) | Select-Object -First 1
if (-not $compiler) { throw 'Prepared MSVC PATH does not resolve cl.exe' }
if ($prepared['VSCMD_ARG_TGT_ARCH'] -ne $arch) { throw 'Prepared MSVC architecture does not match Node' }

# Export only compiler/SDK inputs, never the complete SET output (which contains unrelated secrets).
$names = @('PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'VCToolsInstallDir', 'VCINSTALLDIR', 'VSINSTALLDIR',
    'WindowsSdkDir', 'WindowsSDKVersion', 'WindowsLibPath', 'UniversalCRTSdkDir', 'UCRTVersion',
    'VSCMD_ARG_TGT_ARCH', 'VSCMD_ARG_HOST_ARCH', 'VisualStudioVersion', 'DevEnvDir', 'ExtensionSdkDir')
$lines = [Collections.Generic.List[string]]::new()
foreach ($name in $names) {
    if ($prepared.ContainsKey($name)) {
        $value = $prepared[$name]
        if ($value -match '[\r\n\x00]') { throw "MSVC $name must be a single line" }
        $lines.Add("$name=$value")
    }
}
$lines.Add('CL=')
[IO.File]::AppendAllText($env:GITHUB_ENV, ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
foreach ($name in $names) {
    if ($prepared.ContainsKey($name)) { [Environment]::SetEnvironmentVariable($name, $prepared[$name], 'Process') }
}
Write-Host "MSVC environment prepared: arch=$arch; durationMs=$($started.ElapsedMilliseconds)"
