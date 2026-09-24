# Installation and source builds

English | [简体中文](install.zh-CN.md)

<a id="安装与源码构建"></a>

[Documentation](../README.md) · Next: [Model configuration and first run](quickstart.md)

A source build produces a local runtime directory containing the CLI, background services, and Web workbench. Prepare your environment, build the runtime, then follow the [quickstart](quickstart.md). For a preview of the expected results, see the [demo guide](demo.md).

Source builds are the current distribution method. No official public installer is available yet.

<a id="获取源码"></a>

## Get the source

The public repository is [AgnesAI-Labs/agnes-harness](https://github.com/AgnesAI-Labs/agnes-harness). Copy its clone URL from the Code menu, or run:

```sh
git clone https://github.com/AgnesAI-Labs/agnes-harness.git
cd agnes-harness
```

If you already have a checkout, enter that directory. Run the following commands from the directory containing the root `package.json`.

<a id="环境"></a>

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | `>=24.10`; see [verification](../maintainers/verification.md) for recorded environments |
| pnpm | `10.34.5`, pinned by the root `packageManager`; it can be invoked through Corepack |
| macOS | Xcode Command Line Tools to build native helpers; command sandboxing uses Seatbelt |
| Linux | Command tools require bubblewrap and usable user namespaces; the presence of a bwrap binary alone is insufficient |
| Windows | Headers/import library matching Node, Visual Studio C++ Build Tools, and the Windows SDK; see the platform limits below |

Start with these commands at the repository root:

```sh
node --version
corepack pnpm --version
pnpm install --frozen-lockfile
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs --help
```

If `pnpm` is unavailable, substitute `corepack pnpm` in the following commands. There is no root `pnpm build` script. The CLI package's `build:local` creates the complete local distribution.

Output is written to `packages/cli/dist/local/`, including `agnes.mjs`, daemon, worker, Web, and platform resources. Move the entire directory when relocating a build. `@agnes/web build` builds only the Web package and cannot replace the full local distribution.

On Linux, install bubblewrap through your system package manager, for example `apt install bubblewrap` on Debian/Ubuntu. If user namespaces are disabled, the default sandbox refuses command tools; see [troubleshooting](troubleshooting.md).

<a id="windows-构建"></a>

## Build on Windows

Install dependencies first, then run the following in the same PowerShell session:

```powershell
$ErrorActionPreference = 'Stop'
& .\.github\scripts\prepare-windows-native.ps1 -CacheRoot "$env:LOCALAPPDATA\node-gyp\Cache"
if ($LASTEXITCODE -ne 0) { throw 'Node headers unavailable' }
pnpm.cmd --filter @agnes/cli build:local
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
node .\packages\cli\dist\local\agnes.mjs --help
```

Preparing headers requires network access and a Node installation that includes npm. Rebuild native helpers after upgrading Node. Windows build support and some acceptance code exist, but the PowerShell examples here have not been executed on a Windows machine in the recorded documentation verification. Symbolic links, restricted tokens, network sandboxing, installation, upgrades, and signing require separate validation. Recorded local process verification was performed on macOS.

<a id="独立试用目录"></a>

## Use an isolated trial directory

Use a separate absolute path for documentation experiments so you do not connect to an existing instance. In a POSIX shell:

```sh
export AGH_HOME="$(mktemp -d /tmp/agh-docs.XXXXXX)"
export AGNES_PROFILE=local-dev
node packages/cli/dist/local/agnes.mjs daemon status
node packages/cli/dist/local/agnes.mjs serve
```

In PowerShell:

```powershell
$env:AGH_HOME = Join-Path ([IO.Path]::GetTempPath()) ('agh-docs-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $env:AGH_HOME | Out-Null
$env:AGNES_PROFILE = 'local-dev'
node .\packages\cli\dist\local\agnes.mjs serve
```

For regular use, you may leave `AGH_HOME` unset; the default is `~/.agh`. Instances with the same home/profile/dataDir share a daemon. Different project directories do not automatically isolate accounts or background services. Keep experimental home paths short because Unix sockets have path limits. When the default socket path is too long, the daemon selects a short temporary directory after checking identity and permissions. An explicitly configured socket path that is too long is still rejected.

<a id="重建与版本切换"></a>

## Rebuild or switch versions

Do not overwrite a running distribution, particularly while Windows has a native DLL open. Build to a new output directory first.

Run from the source repository root. `--output-dir` must be absolute: pnpm's `--filter` changes the script's working directory, so a repository-relative path is invalid. In a POSIX shell, create a fresh output location each time:

```sh
AGH_BUILD_ROOT="$(mktemp -d /tmp/agh-build.XXXXXX)"
corepack pnpm --filter @agnes/cli build:local --output-dir "$AGH_BUILD_ROOT/runtime"
node "$AGH_BUILD_ROOT/runtime/agnes.mjs" --help
```

In PowerShell, also from the source repository root:

```powershell
$aghBuildRoot = Join-Path ([IO.Path]::GetTempPath()) ('agh-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $aghBuildRoot | Out-Null
$aghBuildOutput = Join-Path $aghBuildRoot 'runtime'
corepack.cmd pnpm --filter @agnes/cli build:local --output-dir $aghBuildOutput
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
node (Join-Path $aghBuildOutput 'agnes.mjs') --help
```

The POSIX build flow has versioned runtime evidence. The PowerShell example has only had its arguments and path construction reviewed. See [verification](../maintainers/verification.md) for environments and results.

After tasks finish in the old instance, run `daemon stop` through the old distribution, stop its Web service, and then launch the new distribution. Build locks, failed staging directories, and owner records are recovery evidence; deleting them is not a fix for build or daemon errors. Automatic installation, updates, and startup registration are not promised.

Implementation: [toolchain](../../package.json), [local build](../../packages/cli/tools/build-local.ts), [Windows headers](../../.github/scripts/prepare-windows-native.ps1).
