import type { LocaleCatalog, LocaleVars, UiLocale } from '@agnes/web-client'

export const COMPUTER_USE_LOCALE_NAMESPACE = '@agnes/web-computer-use'

const en = {
  'computerUse.intro': 'Let Agnes see the screen and operate apps. This needs a model that accepts images.',
  'computerUse.action.refresh': 'Refresh status',
  'computerUse.status.eyebrow': 'Status',
  'computerUse.permissions.eyebrow': 'System permissions',
  'computerUse.permissions.grant': 'Open macOS authorization',
  'computerUse.doctor.eyebrow': 'Driver diagnostics',
  'computerUse.doctor.run': 'Run diagnostics',
  'computerUse.operation.eyebrow': 'Install and maintenance',
  'computerUse.action.install': 'Prepare driver',
  'computerUse.action.update': 'Update driver',
  'computerUse.action.restart': 'Restart driver',
  'computerUse.action.operationRefresh': 'Refresh progress',
  'computerUse.action.cancel': 'Cancel operation',
  'computerUse.status.pending': 'Waiting for a check',
  'computerUse.status.pendingSummary': "The pane reads this computer's status when it opens.",
  'computerUse.status.checking': 'Checking',
  'computerUse.status.checkingSummary': 'Reading the local Computer Use safety gate.',
  'computerUse.status.running': 'Running',
  'computerUse.status.available': 'Available',
  'computerUse.status.readySummary':
    '{platform} driver {version} is ready. Use an image-capable model in the conversation to operate the computer.',
  'computerUse.runtime.active': 'Runtime: {count} active sessions',
  'computerUse.runtime.idle': 'Runtime: idle now, started before',
  'computerUse.runtime.ready': 'Runtime: ready, no session started yet',
  'computerUse.status.closed': 'Turned off',
  'computerUse.status.unsupported': 'Not supported on this system',
  'computerUse.status.preparing': 'Preparing',
  'computerUse.status.prepareFailed': 'Preparation failed',
  'computerUse.status.firstPrepare': 'Prepares automatically on first use',
  'computerUse.status.refreshRetry': 'Refresh the status and try again.',
  'computerUse.runtime.imageModel':
    'Operating the computer needs an image-capable model. Ordinary chat is unaffected.',
  'computerUse.status.blocked': 'Blocked',
  'computerUse.status.blockedSummary': 'Production driver admission stays closed on this platform.',
  'computerUse.runtime.notStarted': 'Runtime: not started, and start was not attempted',
  'computerUse.status.unreadable': 'Could not read status',
  'computerUse.status.unreadableSummary':
    'Computer Use status could not be read. No driver operation was started.',
  'computerUse.permissions.pending': 'Waiting for a check',
  'computerUse.permissions.pendingSummary': 'Required system permissions appear after the driver is ready.',
  'computerUse.permissions.waitingDriver': 'Waiting for the driver',
  'computerUse.permissions.notRequired': 'No system authorization required',
  'computerUse.permissions.linuxSummary':
    'Linux does not use the macOS Accessibility and screen recording grants. The driver health check covers the desktop session.',
  'computerUse.permissions.windowsSummary':
    'Windows does not need a separate screen recording or accessibility grant.',
  'computerUse.permissions.granted': 'Authorized',
  'computerUse.permissions.grantedSummary': 'Accessibility and screen recording are both authorized.',
  'computerUse.permissions.required': 'Authorization required',
  'computerUse.permissions.requiredSummary':
    'macOS still needs: {missing}. Continuing opens the system settings window.',
  'computerUse.permissions.accessibility': 'Accessibility',
  'computerUse.permissions.screenRecording': 'Screen Recording',
  'computerUse.permissions.unknown': 'Could not confirm',
  'computerUse.permissions.unknownSummary':
    'macOS permissions could not be read from the verified driver. Refresh and try again.',
  'computerUse.permissions.unavailable': 'Unavailable',
  'computerUse.permissions.unavailableSummary':
    'The production driver has not passed admission, so system permissions were not checked.',
  'computerUse.permissions.unreadable': 'Could not read permissions',
  'computerUse.permissions.unreadableSummary':
    'System permissions could not be read. Authorization was not requested.',
  'computerUse.permissions.granting': 'Waiting for system authorization',
  'computerUse.permissions.grantingSummary':
    'Finish Accessibility and screen recording authorization in the macOS system UI.',
  'computerUse.permissions.grantFailed': 'Authorization incomplete',
  'computerUse.permissions.grantFailedSummary':
    'System authorization did not finish or could not be verified. Check system settings and refresh.',
  'computerUse.doctor.pending': 'Waiting for a check',
  'computerUse.doctor.pendingSummary': 'Checks whether the local driver is healthy.',
  'computerUse.doctor.checking': 'Checking',
  'computerUse.doctor.checkingSummary': 'Verifying driver health and signature identity.',
  'computerUse.doctor.passed': 'Check passed',
  'computerUse.doctor.macosSummary': 'The macOS driver health and signature identity are verified.',
  'computerUse.doctor.linuxSummary':
    'The Linux driver health, source identity, and desktop session are verified.',
  'computerUse.doctor.windowsSummary': 'The Windows driver health and signature identity are verified.',
  'computerUse.doctor.failed': 'Check failed',
  'computerUse.doctor.failedSummary':
    'Driver health or signature identity changed. Repair or reinstall, then try again.',
  'computerUse.doctor.failedTemporary': 'Check failed',
  'computerUse.doctor.failedTemporarySummary':
    'The health check could not finish. The driver was not started or repaired.',
  'computerUse.doctor.unreachable': 'Could not connect',
  'computerUse.doctor.unreachableSummary':
    'The live driver diagnostics entry is unavailable. Restart or repair the driver.',
  'computerUse.doctor.skipped': 'Not run',
  'computerUse.doctor.skippedSummary':
    'The production driver has not passed admission, so the health check cannot run.',
  'computerUse.operation.none': 'No record',
  'computerUse.operation.noneSummary':
    'The first use prepares the driver automatically. An existing install is verified and reused.',
  'computerUse.operation.emptySummary': 'This computer has no driver operation to show.',
  'computerUse.operation.queued': 'Waiting to run',
  'computerUse.operation.queuedSummary': 'The driver operation is in the local queue.',
  'computerUse.operation.installing': 'Installing',
  'computerUse.operation.restarting': 'Restarting',
  'computerUse.operation.runningSummary':
    'Checking the installed driver. A missing driver is downloaded and verified. A slow network can take a while; you can cancel and retry.',
  'computerUse.operation.cancelling': 'Cancelling',
  'computerUse.operation.cancellingSummary':
    'Cancellation was requested. Waiting for the current safe step to finish.',
  'computerUse.operation.cancelRequestSummary': 'Asking the local host to stop the driver operation.',
  'computerUse.operation.done': 'Operation finished',
  'computerUse.operation.installed': 'The driver is installed and verified.',
  'computerUse.operation.alreadyCurrent': 'The driver is already the pinned version.',
  'computerUse.operation.repaired': 'The driver was repaired and verified.',
  'computerUse.operation.restarted': 'The driver restarted safely.',
  'computerUse.operation.lkgRestored':
    'The new driver did not pass verification. The previous working version was restored.',
  'computerUse.operation.doneSummary': 'The driver operation has finished.',
  'computerUse.operation.cancelled': 'Cancelled',
  'computerUse.operation.cancelledSummary': 'The driver operation was cancelled before later steps ran.',
  'computerUse.operation.failed': 'Operation failed',
  'computerUse.operation.failedSummary':
    'Driver preparation or maintenance did not finish. Check the network or install environment and try again.',
  'computerUse.operation.progressUnreadable': 'Could not read progress',
  'computerUse.operation.progressUnreadableSummary':
    'The driver operation may still be running in the background. Refresh progress later.',
  'computerUse.operation.stillRunning': 'Still running',
  'computerUse.operation.stillRunningSummary':
    'This is taking a while. The driver operation may still be running. Refresh progress later.',
  'computerUse.operation.submitting': 'Submitting',
  'computerUse.operation.submittingSummary': 'Submitting the driver operation to the local host.',
  'computerUse.operation.startUnknown': 'Could not confirm the start',
  'computerUse.operation.startUnknownSummary':
    'The submit result could not be confirmed. The operation may already have started. Refresh progress and try again.',
  'computerUse.operation.reading': 'Reading',
  'computerUse.operation.readingSummary': 'Reading the latest driver operation.',
  'computerUse.operation.readFailed': 'Could not read the operation',
  'computerUse.operation.readFailedPendingSummary':
    'Progress could not be read. The operation may still be running in the background.',
  'computerUse.operation.readFailedSummary': 'Driver operation progress could not be read.',
  'computerUse.operation.cancelFailed': 'Cancel failed',
  'computerUse.operation.cancelFailedSummary':
    'The cancel result could not be confirmed. Refresh progress and try again.',
  'computerUse.blocker.releaseProvenance':
    'The driver release source and integrity evidence are not locked yet.',
  'computerUse.blocker.compatibility': 'Compatibility evidence for the pinned version is not finished.',
  'computerUse.blocker.platformAcceptance': 'On-device platform acceptance is not finished.',
  'computerUse.blocker.featureDisabled':
    'Computer operation is turned off in the local configuration. Check computerUse.enabled.',
  'computerUse.blocker.platformUnsupported':
    'This operating system or processor cannot operate the computer yet.',
  'computerUse.blocker.driverNotPrepared':
    'The first use prepares the driver automatically. You can also choose Prepare driver.',
  'computerUse.blocker.driverPreparing': 'The driver is being prepared. Wait a moment.',
  'computerUse.blocker.driverPrepareFailed':
    'Driver preparation did not finish. Check the network or install environment, then choose Prepare driver.',
} as const

const zh = {
  'computerUse.intro': '让 Agnes 查看屏幕并操作应用。需要使用支持图片的模型。',
  'computerUse.action.refresh': '刷新状态',
  'computerUse.status.eyebrow': '使用状态',
  'computerUse.permissions.eyebrow': '系统权限',
  'computerUse.permissions.grant': '打开 macOS 授权',
  'computerUse.doctor.eyebrow': '驱动诊断',
  'computerUse.doctor.run': '运行诊断',
  'computerUse.operation.eyebrow': '安装与维护',
  'computerUse.action.install': '准备驱动',
  'computerUse.action.update': '更新驱动',
  'computerUse.action.restart': '重启驱动',
  'computerUse.action.operationRefresh': '刷新进度',
  'computerUse.action.cancel': '取消操作',
  'computerUse.status.pending': '等待检查',
  'computerUse.status.pendingSummary': '打开面板后读取本机状态。',
  'computerUse.status.checking': '正在检查',
  'computerUse.status.checkingSummary': '正在读取本机 Computer Use 安全门状态。',
  'computerUse.status.running': '运行中',
  'computerUse.status.available': '可用',
  'computerUse.status.readySummary':
    '{platform} 驱动 {version} 已就绪。请在对话中使用支持图片的模型操作电脑。',
  'computerUse.runtime.active': '运行时：{count} 个活动会话',
  'computerUse.runtime.idle': '运行时：当前空闲，之前已启动过',
  'computerUse.runtime.ready': '运行时：已就绪，尚未启动会话',
  'computerUse.status.closed': '已关闭',
  'computerUse.status.unsupported': '暂不支持',
  'computerUse.status.preparing': '准备中',
  'computerUse.status.prepareFailed': '准备失败',
  'computerUse.status.firstPrepare': '首次使用自动准备',
  'computerUse.status.refreshRetry': '请刷新状态后重试。',
  'computerUse.runtime.imageModel': '电脑操作需要支持图片的模型；普通聊天不受影响。',
  'computerUse.status.blocked': '已阻止',
  'computerUse.status.blockedSummary': '当前平台的生产驱动准入保持关闭。',
  'computerUse.runtime.notStarted': '运行时：未启动，且未尝试启动',
  'computerUse.status.unreadable': '无法读取',
  'computerUse.status.unreadableSummary': '暂时无法读取 Computer Use 状态；未执行任何驱动操作。',
  'computerUse.permissions.pending': '等待检查',
  'computerUse.permissions.pendingSummary': '驱动就绪后显示当前系统所需的权限。',
  'computerUse.permissions.waitingDriver': '等待驱动就绪',
  'computerUse.permissions.notRequired': '无需系统授权',
  'computerUse.permissions.linuxSummary':
    'Linux 不使用 macOS 的辅助功能和录屏授权；桌面会话能力由驱动健康检查验证。',
  'computerUse.permissions.windowsSummary': 'Windows 无需额外的录屏或辅助功能授权。',
  'computerUse.permissions.granted': '已授权',
  'computerUse.permissions.grantedSummary': '辅助功能和屏幕录制均已授权。',
  'computerUse.permissions.required': '需要授权',
  'computerUse.permissions.requiredSummary': 'macOS 仍需授权：{missing}。点击后由系统设置窗口完成。',
  'computerUse.permissions.accessibility': '辅助功能',
  'computerUse.permissions.screenRecording': '屏幕录制',
  'computerUse.permissions.unknown': '无法确认',
  'computerUse.permissions.unknownSummary': '无法从已验签驱动读取 macOS 权限，请刷新后重试。',
  'computerUse.permissions.unavailable': '不可用',
  'computerUse.permissions.unavailableSummary': '生产驱动尚未通过准入，未检查系统权限。',
  'computerUse.permissions.unreadable': '无法读取',
  'computerUse.permissions.unreadableSummary': '暂时无法读取系统权限；没有发起授权。',
  'computerUse.permissions.granting': '等待系统授权',
  'computerUse.permissions.grantingSummary': '请在 macOS 系统界面完成辅助功能和屏幕录制授权。',
  'computerUse.permissions.grantFailed': '授权未完成',
  'computerUse.permissions.grantFailedSummary': '系统授权未完成或无法验证，请检查系统设置后刷新。',
  'computerUse.doctor.pending': '等待检查',
  'computerUse.doctor.pendingSummary': '检查本机驱动是否正常。',
  'computerUse.doctor.checking': '正在检查',
  'computerUse.doctor.checkingSummary': '正在验证驱动健康状态和签名身份。',
  'computerUse.doctor.passed': '检查通过',
  'computerUse.doctor.macosSummary': 'macOS 驱动健康状态和签名身份均已验证。',
  'computerUse.doctor.linuxSummary': 'Linux 驱动健康状态、来源身份和桌面会话均已验证。',
  'computerUse.doctor.windowsSummary': 'Windows 驱动健康状态和签名身份均已验证。',
  'computerUse.doctor.failed': '检查失败',
  'computerUse.doctor.failedSummary': '驱动健康状态或签名身份已经变化，请修复或重新安装后再试。',
  'computerUse.doctor.failedTemporary': '检查失败',
  'computerUse.doctor.failedTemporarySummary': '暂时无法完成健康检查；没有启动或修复驱动。',
  'computerUse.doctor.unreachable': '无法连接',
  'computerUse.doctor.unreachableSummary': '实时驱动诊断入口不可用，请重新启动或修复驱动。',
  'computerUse.doctor.skipped': '未执行',
  'computerUse.doctor.skippedSummary': '生产驱动尚未通过准入，无法执行健康检查。',
  'computerUse.operation.none': '没有记录',
  'computerUse.operation.noneSummary': '首次使用会自动准备驱动；已有安装会先验证并复用。',
  'computerUse.operation.emptySummary': '本机没有可显示的驱动操作。',
  'computerUse.operation.queued': '等待执行',
  'computerUse.operation.queuedSummary': '驱动操作已进入本机队列。',
  'computerUse.operation.installing': '正在安装',
  'computerUse.operation.restarting': '正在重启',
  'computerUse.operation.runningSummary':
    '正在检查已有驱动；缺失时会下载并验证。网络较慢时需要等待，可取消后重试。',
  'computerUse.operation.cancelling': '正在取消',
  'computerUse.operation.cancellingSummary': '已请求取消；正在等待当前安全步骤结束。',
  'computerUse.operation.cancelRequestSummary': '正在请求本机 Host 停止驱动操作。',
  'computerUse.operation.done': '操作完成',
  'computerUse.operation.installed': '驱动已经安装并通过验证。',
  'computerUse.operation.alreadyCurrent': '当前驱动已经是锁定版本。',
  'computerUse.operation.repaired': '驱动已经修复并通过验证。',
  'computerUse.operation.restarted': '驱动已经安全重启。',
  'computerUse.operation.lkgRestored': '新驱动未通过验证，已恢复上一可用版本。',
  'computerUse.operation.doneSummary': '驱动操作已经完成。',
  'computerUse.operation.cancelled': '已取消',
  'computerUse.operation.cancelledSummary': '驱动操作已取消，未继续执行后续步骤。',
  'computerUse.operation.failed': '操作失败',
  'computerUse.operation.failedSummary': '驱动准备或维护未完成。请检查网络或安装环境后重试。',
  'computerUse.operation.progressUnreadable': '无法读取进度',
  'computerUse.operation.progressUnreadableSummary': '驱动操作可能仍在后台执行，请稍后刷新进度。',
  'computerUse.operation.stillRunning': '仍在执行',
  'computerUse.operation.stillRunningSummary': '等待时间较长，驱动操作仍可能在后台执行，请稍后刷新进度。',
  'computerUse.operation.submitting': '正在提交',
  'computerUse.operation.submittingSummary': '正在向本机 Host 提交驱动操作。',
  'computerUse.operation.startUnknown': '无法确认是否开始',
  'computerUse.operation.startUnknownSummary': '无法确认提交结果；操作可能已在后台开始，请刷新进度后再试。',
  'computerUse.operation.reading': '正在读取',
  'computerUse.operation.readingSummary': '正在读取最近一次驱动操作。',
  'computerUse.operation.readFailed': '无法读取',
  'computerUse.operation.readFailedPendingSummary': '暂时无法读取进度；操作可能仍在后台执行。',
  'computerUse.operation.readFailedSummary': '暂时无法读取驱动操作进度。',
  'computerUse.operation.cancelFailed': '取消失败',
  'computerUse.operation.cancelFailedSummary': '无法确认取消结果，请刷新进度后再试。',
  'computerUse.blocker.releaseProvenance': '驱动发布来源与完整性证据尚未锁定',
  'computerUse.blocker.compatibility': '固定版本兼容性证据尚未完成',
  'computerUse.blocker.platformAcceptance': '平台实机验收尚未完成',
  'computerUse.blocker.featureDisabled': '当前配置已关闭电脑操作，请检查本地配置中的 computerUse.enabled。',
  'computerUse.blocker.platformUnsupported': '当前系统或处理器暂不支持电脑操作。',
  'computerUse.blocker.driverNotPrepared': '首次使用时会自动准备驱动，也可以点击“准备驱动”。',
  'computerUse.blocker.driverPreparing': '正在准备驱动，请稍候。',
  'computerUse.blocker.driverPrepareFailed': '驱动准备未完成。请检查网络或安装环境，然后点击“准备驱动”重试。',
} as const

export const computerUseCatalog: LocaleCatalog = { en: { ...en }, 'zh-CN': { ...zh } }

export type ComputerUsePhrase = Readonly<{ key: keyof typeof en; vars?: LocaleVars }>

export function computerUseLocale(): UiLocale {
  if (typeof document !== 'undefined' && document.documentElement?.lang === 'zh-CN') return 'zh-CN'
  return 'en'
}

export function computerUseText(
  key: string,
  vars?: LocaleVars,
  locale: UiLocale = computerUseLocale(),
): string {
  const template = computerUseCatalog[locale]?.[key] ?? computerUseCatalog.en?.[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
}

export function computerUsePhrase(phrase: ComputerUsePhrase, locale?: UiLocale): string {
  return computerUseText(phrase.key, phrase.vars, locale)
}
