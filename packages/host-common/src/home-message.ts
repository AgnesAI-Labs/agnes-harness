import { isAbsolute } from 'node:path'

/** Fixed refusal text; only a detector-owned absolute path and reason are displayed. */
export function homeVersionMessage(error: unknown, locale?: string): string | undefined {
  const seen = new Set<unknown>()
  let fault: { home: string; reason?: unknown } | undefined
  for (let depth = 0; error && typeof error === 'object' && !seen.has(error) && depth < 8; depth++) {
    seen.add(error)
    if (
      'code' in error &&
      error.code === 'E_HOME_VERSION' &&
      'home' in error &&
      typeof error.home === 'string' &&
      isAbsolute(error.home)
    ) {
      fault = { home: error.home, reason: 'reason' in error ? error.reason : undefined }
      break
    }
    error = 'cause' in error ? error.cause : undefined
  }
  if (!fault) return undefined
  const { home } = fault
  const old = fault.reason === 'unversioned'
  if (locale === 'zh-CN')
    return [
      old
        ? 'E_HOME_VERSION：检测到旧版或未标记的 AGH 运行目录。本版本是新产品，不能使用此布局，也不会迁移旧数据。'
        : 'E_HOME_VERSION：当前运行目录的布局标记无效或版本不受支持。本版本是新产品，不能使用此布局，也不会迁移旧数据。',
      `${old ? '旧环境目录' : '运行目录'}：${home}`,
      '请删除或移走此目录后重新启动，或将 AGH_HOME 指向另一个新的私有空目录。已有文件未被修改。',
      '说明：https://github.com/AgnesAI-Labs/agnes-harness/blob/main/README.zh-CN.md#new-product-clean-home',
    ].join('\n')
  return [
    old
      ? 'E_HOME_VERSION: An old or unversioned AGH home was found. This version is a new product and cannot use this layout. Old data will not be migrated.'
      : "E_HOME_VERSION: The selected home's layout marker is invalid or its version is unsupported. This version is a new product and cannot use this layout. Old data will not be migrated.",
    `${old ? 'Old environment directory' : 'Home directory'}: ${home}`,
    'Remove or move this directory before restarting, or set AGH_HOME to a different, new, empty private directory. Existing files were not changed.',
    'Details: https://github.com/AgnesAI-Labs/agnes-harness/blob/main/README.md#new-product-clean-home',
  ].join('\n')
}
