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

### Optional project toolchain with mise

If you use [mise](https://mise.jdx.dev/), the repository's `mise.toml` pins the development Node and pnpm versions without changing other projects or your global Node installation. The pnpm version must stay aligned with `package.json`'s `packageManager`; the Node engine range remains the compatibility requirement.

Review the project configuration, then run from the repository root:

```sh
mise trust
mise install
mise exec -- node --version
mise exec -- pnpm --version
mise exec -- pnpm install --frozen-lockfile
make dev
```

`make dev` and `make dev-web` automatically use `mise exec --` when mise is on PATH, so no prefix or shell activation is needed for these commands. Without mise, they use the current Node; `make dev NODE=/path/to/node` and `ARGS` overrides remain supported. If mise is available but its configuration or tools fail, the error is reported rather than falling back to a different runtime. The project-local `activate_aggressive` setting keeps the selected tools ahead of other PATH entries. For other Node/pnpm commands on this page, use `mise exec --` or run them directly if your shell already activates mise for this project. mise is optional; an independently prepared toolchain meeting the requirements above still works. Keep runtime installations and long-lived AGH homes outside temporary directories.

### Quick development restart (macOS / Linux)

After installing dependencies and preparing the toolchain above, run from the repository root:

```sh
make dev
```

The default port is `4189`. This builds the complete backend and Web into a new directory before stopping the old daemon and Web and starting the new runtime. A failed build leaves the old service running. It reuses the verified AGH listener's home, profile, dataDir and workspace, then this checkout's saved selection; without either, defaults are `AGH_HOME` (otherwise `~/.agh`), `local-dev`, and this repository. Node defaults to the launcher process's runtime, overridden by `--node` first or `AGH_DEV_NODE` next; a previous instance's Node path does not override the current project toolchain. Session and comparison data are retained. Restarting interrupts active tasks.

```sh
make dev ARGS='--check'                 # Read-only inspection of the selected instance
make dev ARGS='--port 4190 --home /tmp/agh-dev --cwd /path/to/project'
make dev ARGS='--node /path/to/node --env-file /private/path/dev.env'
```

`make dev-web` is an alias. This requires `make`, `lsof`, and `ps`; on Windows use `start-local-windows.ps1`. New processes inherit the launching shell's environment; `--env-file` can supply configuration. The selected home's `dev.env` is also loaded automatically, with existing environment variables taking precedence. On first use, `make dev ARGS='--save-env'` saves only this shell's `AGNES_JEV_*` and `TYPESAFE_API_KEY` variables there (`0600`, no overwrites). Automatic loading rejects other fields, symlinks, and files readable by other users. Keep this home outside the repository and never commit credentials. The launcher does not read or copy secrets from old processes. `Ctrl+C` stops this invocation's Web and corresponding backend. Re-run after source changes; this command does not watch and rebuild automatically.

New `dataDir/daemon` directories are created with mode `0700`; the Unix socket listener refuses a less-private directory. Existing directory permissions are not repaired automatically: inspect ownership and permissions before correcting them.

Unrelated port owners, scope conflicts, unverifiable identities, and concurrent launch transitions are refused. The shared lock is `dataDir/daemon/dev-launch.lock`; inspect its owner before removing a lock left by an abnormal termination. Builds remain in `packages/cli/dist/dev-*/runtime`, and non-secret instance selections in the git-ignored `.agnes-tmp/dev/`. Saved Node paths record the last successful launch only. Old runtime directories are not automatically deleted.

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

On macOS, process identity now combines the stable boot-session UUID, PID and process start time.
The older boot timestamp could drift during clock corrections. Stop old instances before upgrading;
do not replace only the native helper inside a running distribution, because the identity formats differ.

Implementation: [toolchain](../../package.json), [local build](../../packages/cli/tools/build-local.ts), [Windows headers](../../.github/scripts/prepare-windows-native.ps1).
