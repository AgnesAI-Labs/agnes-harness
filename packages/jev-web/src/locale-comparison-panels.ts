import type { LocaleCatalog } from '@agnes/web-client'

/**
 * 双线对比外围面板（child-history / cut-ledger / entry / errors / history / journal /
 * ledger / permission / prepared / replay / trace）的文案。键前缀按文件域：
 * `child.*`、`cut.*`、`centry.*`、`err.*`、`chist.*`、`journal.*`、`cledger.*`、`perm.*`、`prepared.*`、`replay.*`、`ctrace.*`。
 */
export const comparisonPanelsLocaleCatalog: LocaleCatalog = {
  en: {
    'child.ariaLabel': 'Child history',
    'child.close': 'Close child history',
    'child.loading': 'Loading archived child…',
    'child.title': 'Child history',
    'child.chat': 'Chat',
    'child.trace': 'Trace',
    'child.latest': 'Back to latest',
    'child.archived': 'Archived · {count} records',
    'child.link': 'View child {index}',
    'child.readFailed': 'Failed to read child history: {message}',
    'child.retry': 'Please retry',

    'cut.note.complete': 'Full ledger loaded #0–{seq}; the visible range follows the replay position.',
    'cut.note.partial': '{state} #0–{after} / {total}; not fully read, gaps do not mean skipped.',
    'cut.reading': 'Reading',
    'cut.partialHistory': 'Partial history',
    'cut.readFailed': 'Failed to read history: {message}',

    'err.comparison-preparation-busy':
      'A session still holds the run configuration, so a new comparison cannot be prepared. Resolve that session’s waiting or unknown state first, then create a new comparison.',
    'err.workspace-symlink-unsupported':
      'The workspace contains symbolic links this version does not support. Upgrade snapshot support or remove the links, then create a new comparison.',
    'err.workspace-symlink-unresolved':
      'The workspace contains unresolvable or cyclic symbolic links. Fix the links, then create a new comparison.',
    'err.workspace-symlink-excluded-target':
      'A symbolic link points at content excluded from the snapshot. Adjust the link, then create a new comparison.',
    'err.workspace-external-reference-denied':
      'An external file reference is not authorized for reading or points at a protected location. Adjust the reference or its read permissions.',
    'err.workspace-external-reference-unsupported':
      'The file type or permission mode of an external reference is unsupported. Use a capturable regular file instead.',
    'err.workspace-external-reference-changed':
      'An external reference changed during snapshotting. Stop the related writes, then create a new comparison.',
    'err.workspace-manifest-invalid':
      'The snapshot verification record is invalid; two-side isolation cannot be proven. Check storage, then create a new comparison.',
    'err.workspace-snapshot-limit':
      'The workspace exceeds snapshot limits on file count, size, or directory depth. Shrink the workspace, then create a new comparison.',
    'err.workspace-source-changed':
      'The workspace changed during snapshotting. Stop the related writes, then create a new comparison.',
    'err.workspace-read-denied':
      'Workspace content is not authorized for reading. Check workspace read permissions, then create a new comparison.',
    'err.workspace-special-file-unsupported':
      'The workspace contains unsupported special files. Use a workspace that only holds capturable files.',
    'err.workspace-workspace-overlap':
      'The source workspace overlaps the snapshot storage location; isolation cannot be guaranteed. Adjust the workspace or the storage location.',
    'err.workspace-invalid-source':
      'The source workspace is unavailable or of an unsupported type. Pick a usable directory again.',
    'err.workspace-invalid-storage':
      'The snapshot storage location is unavailable. Check the storage configuration.',
    'err.workspace-invalid-configuration':
      'The workspace snapshot configuration is invalid. Check the host configuration.',
    'err.workspace-invalid-limit':
      'The workspace snapshot quota configuration is invalid. Check the host configuration.',
    'err.workspace-invalid-id':
      'The workspace snapshot identity is invalid. Check the saved comparison record.',
    'err.workspace-snapshot-exists':
      'A snapshot already exists for this creation identity. Check the original record and cleanup state to avoid duplicate creation.',
    'err.workspace-copy-failed':
      'Copying workspace files failed. Check storage and read permissions, then create a new comparison.',
    'err.workspace-cleanup-failed':
      'Snapshot cleanup is unconfirmed. Verify the cleanup state before handling resources.',
    'err.workspace-snapshot-failed':
      'Preparing the workspace snapshot failed. Check the workspace, storage, and cleanup state.',
    'err.comparison-isolation-required':
      'Comparison runs require filesystem isolation with unrestricted mode disabled. Check the comparison run configuration.',
    'err.comparison-writable-overlap':
      'The two sides have overlapping or shared writable directories; independent execution cannot be guaranteed. Adjust the writable scope, then create a new comparison.',
    'err.generic':
      'Comparison preparation failed; this record saved no public reason and legacy records cannot backfill one. Check the cleanup state, then create a new comparison.',

    'chist.title': 'Saved comparisons',
    'chist.refresh': 'Refresh saved comparisons',
    'chist.more': 'Load more comparisons',
    'chist.phase.preparing': 'Preparing',
    'chist.phase.ready': 'Ready',
    'chist.phase.running': 'Running',
    'chist.phase.partial': 'Partial',
    'chist.phase.completed': 'Completed',
    'chist.phase.cancelled': 'Cancelled',
    'chist.phase.failed': 'Failed',
    'chist.unknown': 'Unknown',
    'chist.row': '{id} · {phase} · {rounds} turns',
    'chist.left': 'Left',
    'chist.right': 'Right',
    'chist.facts': '{lanes}; created {created}; updated {updated}',
    'chist.reasonPreparing': 'Still preparing; no inspectable two-side sessions yet.',
    'chist.reasonIncomplete': 'No complete two-side sessions yet; cannot open it now.',
    'chist.loading': 'Loading saved comparisons…',
    'chist.listed': 'Showing {count} comparisons; statuses reflect the latest fetched summaries.',
    'chist.empty': 'No saved comparisons yet.',
    'chist.listFailed': 'Listing failed; displayed content kept: {message}',
    'chist.openFailed': 'Failed to open: {message}',
    'chist.retry': 'Please retry',
    'chist.retired': 'This list read was discarded; refresh to read again.',

    'journal.readFailed': 'Failed to read the shared journal: {message}',

    'cledger.note.complete': 'Full ledger loaded #0–{seq}; the visible range follows the replay position.',
    'cledger.note.partial': '{state} #0–{after} / {total}; not fully read, gaps do not mean skipped.',
    'cledger.reading': 'Reading',
    'cledger.partialHistory': 'Partial history',
    'cledger.readFailed': 'Failed to read history: {message}',

    'perm.view.label': 'Auto-deny approvals',
    'perm.view.description':
      'Approval-requiring operations are denied automatically; not the same as filesystem read-only isolation',
    'perm.workspace.label': 'Manual approvals',
    'perm.workspace.description':
      'Approval-requiring operations wait for confirmation; both sides keep comparison directory isolation',
    'perm.full.label': 'Auto-approve (keeps isolation)',
    'perm.full.description':
      'Skips interactive approvals; keeps comparison directory isolation, safety denials, and system permissions',
    'perm.label.missing': 'Permission mode not recorded',

    'prepared.noReceipt':
      'Prepared configuration: unknown (no trusted frozen receipt for this prefix; history is not backfilled from current configuration)',
    'prepared.summary': 'Prepared configuration · {preset} · {runtime} · source #{seq}',
    'prepared.note':
      'Frozen from the session’s actual state. The preset fingerprint covers the resolved execution settings. {mounted}The tool fingerprint covers registered definitions; model-visible tools remain subject to capability filtering.',
    'prepared.note.mounted':
      'The mounted-configuration fingerprint covers the plugins and selected preset that were effective then.',
    'prepared.note.mountUnknown':
      'Mounted configuration: unknown (this receipt has no trusted mount evidence).',
    'prepared.model': 'Model {slot}',
    'prepared.modelValue':
      '{route} / {model} · thinking {thinking} · context {context} · preset output cap {limit}',
    'prepared.unknownRoute': 'Unknown route',
    'prepared.unknownModel': 'Unknown model',
    'prepared.unknown': 'Unknown',
    'prepared.limit.unrecorded': 'Unknown (legacy receipts did not record it)',
    'prepared.limit.unconfigured': 'Not configured separately',
    'prepared.limit.noOverride': 'No override set',
    'prepared.approvalMode': 'Effective approval mode',
    'prepared.yolo': 'YOLO',
    'prepared.enabled': 'Enabled',
    'prepared.disabled': 'Disabled',
    'prepared.isolation': 'Isolation strength',
    'prepared.registeredTools': 'Registered tools',
    'prepared.mountedCount': 'Effective mounted entries',
    'prepared.decisionConnection': 'Decision connection',
    'prepared.frozenRuntime': 'Frozen runtime settings',
    'prepared.runtimeConfig': 'Runtime-specific configuration',
    'prepared.runtimeConfigNone': 'None (Native)',
    'prepared.fingerprint': 'Fingerprint {name}',
    'prepared.sourceDigest': 'Source event digest',
    'prepared.policyDigest': 'Effective permission policy digest',

    'replay.aria.label': 'Two-side shared ledger replay',
    'replay.aria.position': 'Two-side shared replay position',
    'replay.aria.speed': 'Two-side replay speed',
    'replay.play': 'Play',
    'replay.pause': 'Pause',
    'replay.restart': 'Replay from start',
    'replay.previous': 'Previous',
    'replay.next': 'Next',
    'replay.live': 'Live',
    'replay.syncing': 'Syncing both sides, keeping the previous position',
    'replay.livePrefix': 'Live persisted records',
    'replay.journalPrefix': 'Shared journal #{seq}',
    'replay.stepPrefix': 'Step {position}',
    'replay.ordering.journal': 'Backend publication order · shared cursor #{seq} / #{through}',
    'replay.ordering.perLane':
      'per-lane-only: per-side record order, not a global timeline (no shared journal)',
    'replay.ordering.error': 'Shared journal unavailable; keeping the previous position',
    'replay.ordering.loading': 'Loading the shared journal',
    'replay.checkpoint': ' · {reason} checkpoint #{seq}: historical prefix interleaving unknown{perLane}',
    'replay.checkpoint.perLane': ', per-side order only',
    'replay.sides': 'left #{left} / right #{right}',
    'replay.noData': ' · no ledger data yet',
    'replay.incomplete': ' · history still loading or not fully read',
    'replay.loadingPrefix': ' · reading the fixed journal prefix',
    'replay.status': '{prefix} · {sides}{noData}{incomplete}; {ordering}{coverage}{loading}{error}',
    'replay.fact': 'Shared fact #{seq} · {kind}',
  },
  'zh-CN': {
    'child.ariaLabel': '子任务历史',
    'child.close': '关闭子任务历史',
    'child.loading': '正在读取已归档的子任务…',
    'child.title': '子任务历史',
    'child.chat': '对话',
    'child.trace': '轨迹',
    'child.latest': '回到最新',
    'child.archived': '已归档 · {count} 条记录',
    'child.link': '查看子任务 {index}',
    'child.readFailed': '读取子任务历史失败：{message}',
    'child.retry': '请重试',

    'cut.note.complete': '已载入完整账本 #0–{seq}；当前展示范围见回放位置。',
    'cut.note.partial': '{state} #0–{after} / {total}；尚未读全，缺失不表示未执行。',
    'cut.reading': '正在读取',
    'cut.partialHistory': '部分历史',
    'cut.readFailed': '历史读取失败：{message}',

    'err.comparison-preparation-busy':
      '已有会话仍持有运行配置，当前无法准备新对比。请先处理该会话的等待或未知状态，再新建对比。',
    'err.workspace-symlink-unsupported':
      '工作区含此版本尚不支持的符号链接。请升级快照支持，或移除该引用后新建对比。',
    'err.workspace-symlink-unresolved': '工作区含无法解析或循环引用的符号链接。请修复引用后新建对比。',
    'err.workspace-symlink-excluded-target': '符号链接指向未纳入快照的内容。请调整引用后新建对比。',
    'err.workspace-external-reference-denied':
      '外部文件引用未获读取授权，或指向受保护位置。请调整引用或读取权限。',
    'err.workspace-external-reference-unsupported':
      '外部引用的文件类型或权限模式不受支持。请改用可捕获的普通文件。',
    'err.workspace-external-reference-changed': '外部引用在快照期间发生变化。请停止相关写入后新建对比。',
    'err.workspace-manifest-invalid': '快照校验记录无效，无法证明两侧隔离。请检查存储后新建对比。',
    'err.workspace-snapshot-limit': '工作区超过快照的文件数、容量或目录深度限制。请缩小工作区后新建对比。',
    'err.workspace-source-changed': '工作区在快照期间发生变化。请停止相关写入后新建对比。',
    'err.workspace-read-denied': '工作区内容未获读取授权。请检查工作区读取权限后新建对比。',
    'err.workspace-special-file-unsupported': '工作区含不支持的特殊文件。请使用仅含可捕获文件的工作区。',
    'err.workspace-workspace-overlap': '源工作区与快照存储位置重叠，无法保证隔离。请调整工作区或存储位置。',
    'err.workspace-invalid-source': '源工作区不可用或类型不符合要求。请重新选择可用目录。',
    'err.workspace-invalid-storage': '快照存储位置不可用。请检查存储配置。',
    'err.workspace-invalid-configuration': '工作区快照配置无效。请检查宿主配置。',
    'err.workspace-invalid-limit': '工作区快照限额配置无效。请检查宿主配置。',
    'err.workspace-invalid-id': '工作区快照身份无效。请检查保存的对比记录。',
    'err.workspace-snapshot-exists': '此创建身份已有快照。请核对原记录和清理状态，避免重复创建。',
    'err.workspace-copy-failed': '工作区文件复制失败。请检查存储和读取权限后新建对比。',
    'err.workspace-cleanup-failed': '快照清理尚未确认。请核对清理状态后再处理资源。',
    'err.workspace-snapshot-failed': '工作区快照准备失败。请检查工作区、存储和清理状态。',
    'err.comparison-isolation-required': '对比运行需要启用文件系统隔离并关闭不受限模式。请检查对比运行配置。',
    'err.comparison-writable-overlap':
      '两侧存在重叠或共享的可写目录，无法保证独立运行。请调整可写范围后新建对比。',
    'err.generic':
      '对比准备失败；此记录未保存可公开的具体原因，旧记录不能补推原因。请核对清理状态后新建对比。',

    'chist.title': '已保存对比',
    'chist.refresh': '刷新已保存对比',
    'chist.more': '加载更多对比',
    'chist.phase.preparing': '准备中',
    'chist.phase.ready': '已就绪',
    'chist.phase.running': '运行中',
    'chist.phase.partial': '部分完成',
    'chist.phase.completed': '已完成',
    'chist.phase.cancelled': '已取消',
    'chist.phase.failed': '失败',
    'chist.unknown': '未知',
    'chist.row': '{id} · {phase} · {rounds} 轮',
    'chist.left': '左',
    'chist.right': '右',
    'chist.facts': '{lanes}；创建：{created}；更新：{updated}',
    'chist.reasonPreparing': '仍在准备，尚无可检查的双侧会话。',
    'chist.reasonIncomplete': '尚无完整的双侧会话，当前无法打开。',
    'chist.loading': '正在读取已保存对比…',
    'chist.listed': '已显示 {count} 个对比；状态为最近读取的已提交摘要。',
    'chist.empty': '尚无已保存对比。',
    'chist.listFailed': '列表读取失败，已显示内容保留：{message}',
    'chist.openFailed': '打开失败：{message}',
    'chist.retry': '请重试',
    'chist.retired': '本次列表读取已作废，可刷新重新读取。',

    'journal.readFailed': '共享 journal 读取失败：{message}',

    'cledger.note.complete': '已载入完整账本 #0–{seq}；当前展示范围见回放位置。',
    'cledger.note.partial': '{state} #0–{after} / {total}；尚未读全，缺失不表示未执行。',
    'cledger.reading': '正在读取',
    'cledger.partialHistory': '部分历史',
    'cledger.readFailed': '历史读取失败：{message}',

    'perm.view.label': '自动拒绝审批',
    'perm.view.description': '需审批的操作自动拒绝；不等同于文件系统只读隔离',
    'perm.workspace.label': '手动审批',
    'perm.workspace.description': '需审批的操作等待确认；两侧保持对比目录隔离',
    'perm.full.label': '自动审批（保持隔离）',
    'perm.full.description': '跳过交互审批；保留对比目录隔离、安全禁令和系统权限',
    'perm.label.missing': '权限模式未记录',

    'prepared.noReceipt': '准备配置：未知（此前缀无可信冻结回执；不以当前配置补历史）',
    'prepared.summary': '准备配置 · {preset} · {runtime} · 源 #{seq}',
    'prepared.note':
      '冻结自会话实际状态。预设指纹覆盖已解析的执行设置。{mounted}工具指纹覆盖已注册定义，具体模型可见工具仍受能力过滤。',
    'prepared.note.mounted': '挂载配置指纹覆盖当时已生效的插件及选中预设。',
    'prepared.note.mountUnknown': '挂载配置：未知（此回执无可信挂载证据）。',
    'prepared.model': '模型 {slot}',
    'prepared.modelValue':
      '{route} / {model} · thinking {thinking} · 上下文 {context} · 预设输出上限 {limit}',
    'prepared.unknownRoute': '未知路由',
    'prepared.unknownModel': '未知模型',
    'prepared.unknown': '未知',
    'prepared.limit.unrecorded': '未知（旧回执未记录）',
    'prepared.limit.unconfigured': '未独立配置',
    'prepared.limit.noOverride': '未设置覆盖值',
    'prepared.approvalMode': '实际审批模式',
    'prepared.yolo': 'YOLO',
    'prepared.enabled': '启用',
    'prepared.disabled': '关闭',
    'prepared.isolation': '隔离强度',
    'prepared.registeredTools': '已注册工具',
    'prepared.mountedCount': '已生效配置项',
    'prepared.decisionConnection': '决策连接',
    'prepared.frozenRuntime': '冻结运行设置',
    'prepared.runtimeConfig': '运行专用配置',
    'prepared.runtimeConfigNone': '无（Native）',
    'prepared.fingerprint': '指纹 {name}',
    'prepared.sourceDigest': '源事件摘要',
    'prepared.policyDigest': '实际权限策略摘要',

    'replay.aria.label': '双侧共享账本回放',
    'replay.aria.position': '双侧共享回放位置',
    'replay.aria.speed': '双侧回放速度',
    'replay.play': '播放',
    'replay.pause': '暂停',
    'replay.restart': '从头回放',
    'replay.previous': '上一项',
    'replay.next': '下一项',
    'replay.live': '实时',
    'replay.syncing': '正在同步两侧，保留上一位置',
    'replay.livePrefix': '实时持久记录',
    'replay.journalPrefix': '共享 journal #{seq}',
    'replay.stepPrefix': '同步步进 {position}',
    'replay.ordering.journal': '后端持久发布顺序 · 共享 cursor #{seq} / #{through}',
    'replay.ordering.perLane': 'per-lane-only：按各侧记录顺序，非全局时序（无共享 journal）',
    'replay.ordering.error': '共享 journal 不可用，保留上一位置',
    'replay.ordering.loading': '正在载入共享 journal',
    'replay.checkpoint': ' · {reason} checkpoint #{seq}：历史前缀交错未知{perLane}',
    'replay.checkpoint.perLane': '，仅单侧顺序',
    'replay.sides': '左 #{left} / 右 #{right}',
    'replay.noData': ' · 尚无账本数据',
    'replay.incomplete': ' · 历史读取中或尚未读全',
    'replay.loadingPrefix': ' · 正在读取固定 journal 前缀',
    'replay.status': '{prefix} · {sides}{noData}{incomplete}；{ordering}{coverage}{loading}{error}',
    'replay.fact': '共享事实 #{seq} · {kind}',
  },
}
