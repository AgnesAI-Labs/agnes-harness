import { JsonRpcError } from '@agnes/sdk/browser'

const reasons: Readonly<Record<string, string>> = {
  COMPARISON_PREPARATION_BUSY:
    '已有会话仍持有运行配置，当前无法准备新对比。请先处理该会话的等待或未知状态，再新建对比。',
  WORKSPACE_SYMLINK_UNSUPPORTED: '工作区含此版本尚不支持的符号链接。请升级快照支持，或移除该引用后新建对比。',
  WORKSPACE_SYMLINK_UNRESOLVED: '工作区含无法解析或循环引用的符号链接。请修复引用后新建对比。',
  WORKSPACE_SYMLINK_EXCLUDED_TARGET: '符号链接指向未纳入快照的内容。请调整引用后新建对比。',
  WORKSPACE_EXTERNAL_REFERENCE_DENIED: '外部文件引用未获读取授权，或指向受保护位置。请调整引用或读取权限。',
  WORKSPACE_EXTERNAL_REFERENCE_UNSUPPORTED: '外部引用的文件类型或权限模式不受支持。请改用可捕获的普通文件。',
  WORKSPACE_EXTERNAL_REFERENCE_CHANGED: '外部引用在快照期间发生变化。请停止相关写入后新建对比。',
  WORKSPACE_MANIFEST_INVALID: '快照校验记录无效，无法证明两侧隔离。请检查存储后新建对比。',
  WORKSPACE_SNAPSHOT_LIMIT: '工作区超过快照的文件数、容量或目录深度限制。请缩小工作区后新建对比。',
  WORKSPACE_SOURCE_CHANGED: '工作区在快照期间发生变化。请停止相关写入后新建对比。',
  WORKSPACE_READ_DENIED: '工作区内容未获读取授权。请检查工作区读取权限后新建对比。',
  WORKSPACE_SPECIAL_FILE_UNSUPPORTED: '工作区含不支持的特殊文件。请使用仅含可捕获文件的工作区。',
  WORKSPACE_WORKSPACE_OVERLAP: '源工作区与快照存储位置重叠，无法保证隔离。请调整工作区或存储位置。',
  WORKSPACE_INVALID_SOURCE: '源工作区不可用或类型不符合要求。请重新选择可用目录。',
  WORKSPACE_INVALID_STORAGE: '快照存储位置不可用。请检查存储配置。',
  WORKSPACE_INVALID_CONFIGURATION: '工作区快照配置无效。请检查宿主配置。',
  WORKSPACE_INVALID_LIMIT: '工作区快照限额配置无效。请检查宿主配置。',
  WORKSPACE_INVALID_ID: '工作区快照身份无效。请检查保存的对比记录。',
  WORKSPACE_SNAPSHOT_EXISTS: '此创建身份已有快照。请核对原记录和清理状态，避免重复创建。',
  WORKSPACE_COPY_FAILED: '工作区文件复制失败。请检查存储和读取权限后新建对比。',
  WORKSPACE_CLEANUP_FAILED: '快照清理尚未确认。请核对清理状态后再处理资源。',
  WORKSPACE_SNAPSHOT_FAILED: '工作区快照准备失败。请检查工作区、存储和清理状态。',
  COMPARISON_ISOLATION_REQUIRED: '对比运行需要启用文件系统隔离并关闭不受限模式。请检查对比运行配置。',
  COMPARISON_WRITABLE_OVERLAP: '两侧存在重叠或共享的可写目录，无法保证独立运行。请调整可写范围后新建对比。',
}
const generic = '对比准备失败；此记录未保存可公开的具体原因，旧记录不能补推原因。请核对清理状态后新建对比。'

/** Decode only public creation codes; remote messages, paths and unknown workspace codes stay hidden. */
export function comparisonCreationMessage(error: unknown): string | undefined {
  if (!(error instanceof JsonRpcError)) return undefined
  const code = error.data.code
  if (typeof code !== 'string') return undefined
  if (Object.hasOwn(reasons, code)) return `${reasons[code]}（${code}）`
  if (code === 'COMPARISON_CREATE_FAILED' || code.startsWith('WORKSPACE_')) return generic
  return undefined
}
