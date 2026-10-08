/** CLI startup and home errors use fixed text, never an upstream error body. */
const en = {
  home: 'Home',
  profile: 'Profile',
  doctor: 'Doctor',
  ok: 'ready',
  warn: 'needs attention',
  fail: 'checks failed',
  port: 'The Web port is already in use. Choose another port with --port or stop the listener that owns it.',
  writable:
    'The AGH home is not writable. Choose a private writable directory with AGH_HOME; check ownership and permissions.',
  credentials:
    'The credential store is unavailable or unsafe. Check private directory mode 0700 and file mode 0600; run agh doctor.',
  version:
    'This home layout is unsupported. Set AGH_HOME to a new empty private directory; existing files were not changed.',
  unsafe:
    'The home contains unsafe links or files. Check ownership and restore a private regular directory before retrying.',
} as const
const zh: Record<keyof typeof en, string> = {
  home: '运行目录',
  profile: '配置档',
  doctor: '运行诊断',
  ok: '就绪',
  warn: '需要关注',
  fail: '检查未通过',
  port: 'Web 端口已被占用。使用 --port 选择其他端口，或停止占用它的服务。',
  writable: 'AGH 运行目录不可写。通过 AGH_HOME 选择私有可写目录，并检查所有者和权限。',
  credentials: '凭据存储不可用或不安全。检查目录权限 0700、文件权限 0600，然后运行 agh doctor。',
  version: '此运行目录的布局不受支持。请通过 AGH_HOME 选择新的私有空目录；已有文件未被修改。',
  unsafe: '运行目录包含不安全的链接或文件。请检查所有者，并恢复为私有普通目录后重试。',
}
export const firstRunText = (env: Readonly<Record<string, string | undefined>>, key: keyof typeof en) =>
  (env.AGNES_LOCALE === 'zh-CN' ? zh : en)[key]
export function startupFailure(
  error: unknown,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const key =
    code === 'EADDRINUSE'
      ? 'port'
      : ['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(String(code))
        ? 'writable'
        : code === 'E_HOME_VERSION'
          ? 'version'
          : code === 'E_HOME_UNSAFE'
            ? 'unsafe'
            : ['CREDENTIAL_STORE_UNSAFE', 'CONFIG_CREDENTIAL_STORE', 'E_SECRET_UNRESOLVED'].includes(
                  String(code),
                )
              ? 'credentials'
              : undefined
  return key ? firstRunText(env, key) : undefined
}

const doctorCatalog = {
  en: {
    'doctor.check.node': 'Node.js runtime',
    'doctor.check.native': 'Native helpers',
    'doctor.check.home': 'Home layout',
    'doctor.check.permissions': 'Private files and permissions',
    'doctor.check.credentials': 'Credential storage',
    'doctor.check.sandbox': 'Local command isolation',
    'doctor.check.connection': 'Daemon connection',
    'doctor.check.disk': 'Available disk space',
    'doctor.check.accounts': 'Model accounts',
    'doctor.check.plugins': 'Plugin integrity',
    'doctor.check.mcp': 'MCP command isolation',
    'doctor.fix.node': 'Use Node.js 24.10 or newer, then restart AGH.',
    'doctor.fix.native': 'Rebuild the native helpers or reinstall the matching AGH release.',
    'doctor.fix.home':
      'Run agh home info. If the layout is unsupported, set AGH_HOME to a new empty private directory. Existing files are left untouched.',
    'doctor.fix.permissions':
      'Check ownership: private directories need mode 0700 and credential/configuration files mode 0600. On Windows, check private ACLs.',
    'doctor.fix.credentials':
      'Check private credential storage and re-add an account whose credential is missing. No key values appear in diagnostics.',
    'doctor.fix.sandbox':
      'Enable the OS sandbox: Seatbelt on macOS, bubblewrap and user namespaces on Linux. Check Landlock support with agh doctor platform. Unavailable isolation refuses protected commands.',
    'doctor.fix.connection':
      'Start AGH with the same home and profile. If the Web port is busy, choose another with --port.',
    'doctor.fix.disk': 'Free space on the home volume. Review session data before removing any files.',
    'doctor.fix.accounts':
      'Add and test a model account in Settings, then choose a default model. You can also skip setup and use the local demo.',
    'doctor.fix.plugins':
      'Review plugin integrity in Settings. Restore the matching package before enabling it; do not delete the lock file.',
    'doctor.fix.mcp':
      'Local MCP commands require a working sandbox and their configured sandbox profile. Review MCP settings and trust before enabling a server.',
  },
  'zh-CN': {
    'doctor.check.node': 'Node.js 运行环境',
    'doctor.check.native': '原生辅助程序',
    'doctor.check.home': '运行目录布局',
    'doctor.check.permissions': '私有文件与权限',
    'doctor.check.credentials': '凭据存储',
    'doctor.check.sandbox': '本地命令隔离',
    'doctor.check.connection': 'Daemon 连接',
    'doctor.check.disk': '磁盘可用空间',
    'doctor.check.accounts': '模型账户',
    'doctor.check.plugins': '插件完整性',
    'doctor.check.mcp': 'MCP 命令隔离',
    'doctor.fix.node': '请使用 Node.js 24.10 或更新版本，然后重启 AGH。',
    'doctor.fix.native': '请重新构建原生辅助程序，或重新安装匹配的 AGH 版本。',
    'doctor.fix.home':
      '运行 agh home info。若布局不受支持，请通过 AGH_HOME 选择新的私有空目录。已有文件不会被修改。',
    'doctor.fix.permissions':
      '请检查所有者：私有目录权限应为 0700，凭据和配置文件应为 0600；Windows 请检查私有 ACL。',
    'doctor.fix.credentials': '检查私有凭据存储；缺少凭据的账户需重新添加。诊断不会显示密钥内容。',
    'doctor.fix.sandbox':
      '启用系统沙箱：macOS 使用 Seatbelt，Linux 使用 bubblewrap 与用户命名空间。运行 agh doctor platform 可检查 Landlock 支持；隔离不可用时，受保护的命令会被拒绝。',
    'doctor.fix.connection':
      '使用相同的运行目录和配置档启动 AGH。Web 端口被占用时，可用 --port 选择其他端口。',
    'doctor.fix.disk': '释放运行目录所在磁盘的空间。处理任何文件前，请先审阅会话数据。',
    'doctor.fix.accounts': '在设置中添加并测试模型账户，然后选择默认模型。也可以跳过配置，使用本地演示模型。',
    'doctor.fix.plugins': '在设置中检查插件完整性；启用前先恢复匹配的插件包，不要删除锁文件。',
    'doctor.fix.mcp': '本地 MCP 命令需要可用的沙箱及配置的沙箱预设。启用服务前，请检查 MCP 设置与信任状态。',
  },
}
export function doctorText(env: Readonly<Record<string, string | undefined>>, key: string) {
  const catalog: Record<string, string> =
    env.AGNES_LOCALE === 'zh-CN' ? doctorCatalog['zh-CN'] : doctorCatalog.en
  return catalog[key] ?? firstRunText(env, 'doctor')
}
