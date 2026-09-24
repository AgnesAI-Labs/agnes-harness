import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !isAbsolute(args[1])))
  throw new Error('Expected --output-dir with an absolute directory')
const output = args[1] ?? join(root, 'dist', 'native')
mkdirSync(output, { recursive: true })

if (process.platform === 'darwin') {
  const candidates = [
    process.env.AGNES_NODE_HEADERS,
    join(dirname(dirname(process.execPath)), 'include', 'node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
  ].filter(Boolean)
  const include = candidates
    .flatMap((candidate) => [candidate, join(candidate, 'include', 'node')])
    .find((candidate) => existsSync(join(candidate, 'node_api.h')))
  if (!include) throw new Error('Node headers missing: install them or set AGNES_NODE_HEADERS')
  execFileSync(
    process.env.CC ?? 'clang',
    [
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-O2',
      '-std=c17',
      '-DNAPI_VERSION=8',
      `-I${include}`,
      join(root, 'native', 'macos.c'),
      '-o',
      join(output, 'agnes-system.node'),
    ],
    { cwd: output, stdio: 'inherit' },
  )
  process.exit(0)
}

if (process.platform === 'linux') {
  const candidates = [
    process.env.AGNES_NODE_HEADERS,
    join(dirname(dirname(process.execPath)), 'include', 'node'),
    '/usr/include/node',
    '/usr/local/include/node',
  ].filter(Boolean)
  const include = candidates
    .flatMap((candidate) => [candidate, join(candidate, 'include', 'node')])
    .find((candidate) => existsSync(join(candidate, 'node_api.h')))
  if (!include) throw new Error('Node headers missing: install them or set AGNES_NODE_HEADERS')
  execFileSync(
    process.env.CC ?? 'cc',
    [
      '-shared',
      '-fPIC',
      '-O2',
      '-std=c17',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-DNAPI_VERSION=8',
      `-I${include}`,
      join(root, 'native', 'linux.c'),
      '-o',
      join(output, 'agnes-system.node'),
    ],
    { cwd: output, stdio: 'inherit' },
  )
  process.exit(0)
}

if (process.platform !== 'win32') process.exit(0) // guards-allow-platform: unsupported native platform.
const arch = process.arch // guards-allow-platform: match the Node runtime loading the native artifact.
if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows native architecture')
const windowsHeaders =
  process.env.AGNES_NODE_HEADERS ??
  join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'node-gyp',
    'Cache',
    process.versions.node,
  )
const include = join(windowsHeaders, 'include', 'node')
const library = join(windowsHeaders, arch, 'node.lib')
if (!existsSync(join(include, 'node_api.h')) || !existsSync(library))
  throw new Error(
    'Node headers/library missing: install headers for this Node version or set AGNES_NODE_HEADERS',
  )

// CL 从 CL 环境变量追加命令行参数；本机若设了 `CL=/utf-8`，Git for Windows 的 MSYS 路径转换会把它
// 变成 `-F:/git/Git/utf-8`，cl 当成源文件并最终 LNK1181。先剔除再导入，避免污染 VsDevCmd 环境块。
const parentEnv = { ...process.env }
delete parentEnv.CL

let environment = parentEnv
if (!process.env.VCToolsInstallDir) {
  const vswhere = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  )
  // vswhere 输出的是 ANSI 码页字节（VS 装在含中文等非 ASCII 路径时 Node 按 UTF-8 解码会得到乱码）。
  // 借 PowerShell 按系统 ANSI 码页解码，再以 UTF-8 回传给 Node。
  const quoted = vswhere.replaceAll("'", "''")
  const install = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::Default; ' +
        `$p = & '${quoted}' -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath; ` +
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Out.Write($p)',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  const setup = join(install, 'Common7', 'Tools', 'VsDevCmd.bat')
  if (!install || !existsSync(setup) || /["%!\r\n]/.test(setup))
    throw new Error('Use a Visual Studio Developer shell with the C++ build tools installed')
  // VsDevCmd.bat 输出的环境块是 ANSI 码页字节。直接按 UTF-8 解码会把非 ASCII 的 VS 安装路径
  // 变成乱码，cl.exe / INCLUDE / LIB 全都指向不存在的目录。走 PowerShell：用系统码页读取 cmd
  // 输出（PowerShell 会按 [Console]::OutputEncoding 正确解码），再以 UTF-8 写文件回传。
  const envDump = join(output, 'vs-env.txt')
  const bridge = join(output, 'vs-env.ps1')
  writeFileSync(
    bridge,
    [
      '$setup = $args[0]',
      `$env:PATH = "${dirname(vswhere)};$env:PATH"`,
      '[Console]::OutputEncoding = [Text.Encoding]::Default',
      `cmd /c "call ""$setup"" -no_logo -arch=${arch} >nul && set" |`,
      '  Out-File -FilePath $args[1] -Encoding UTF8',
    ].join('\n'),
    'utf8',
  )
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridge, setup, envDump],
    { encoding: 'utf8', windowsHide: true },
  )
  const text = readFileSync(envDump, 'utf8').replace(/^﻿/, '')
  environment = {}
  for (const line of text.split(/\r?\n/)) {
    const split = line.indexOf('=')
    if (split > 0) environment[line.slice(0, split)] = line.slice(split + 1)
  }
}
// CL 环境变量由 cl.exe 在命令行之外追加读取。本机若设了 `/utf-8`，Git for Windows 的 MSYS 路径
// 转换会把它改写成 `F:/git/Git/utf-8`，cl 遂将其当作源文件，编译期报 D9024、链接期 LNK1181。
// 构建参数全部由本脚本显式给出，直接剔除继承来的 CL 即可。
const clEnv = { ...environment }
delete clEnv.CL
// Node 在 Windows 上按父进程 PATH 搜索可执行文件，而不是你传入的 env.PATH，所以要把 cl.exe
// 解析成完整路径再调用，否则 VsDevCmd 导入出的 MSVC 目录不会被看到。
const cl = (environment.PATH ?? '')
  .split(';')
  .map((dir) => join(dir.trim(), 'cl.exe'))
  .find((candidate) => existsSync(candidate))
execFileSync(
  cl ?? 'cl.exe',
  [
    '/nologo',
    '/LD',
    '/EHsc',
    '/W4',
    '/WX',
    '/O2',
    '/std:c++17',
    '/DNAPI_VERSION=8',
    `/I${include}`,
    join(root, 'native', 'windows.cc'),
    join(root, 'native', 'node-delay-load.cc'),
    library,
    'advapi32.lib',
    'bcrypt.lib',
    'crypt32.lib',
    'wintrust.lib',
    'delayimp.lib',
    '/link',
    '/DELAYLOAD:node.exe',
    `/OUT:${join(output, 'agnes-system.node')}`,
  ],
  { cwd: output, env: clEnv, stdio: 'inherit', windowsHide: true },
)
