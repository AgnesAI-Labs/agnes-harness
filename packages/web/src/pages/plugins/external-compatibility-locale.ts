import type { LocaleCatalog } from '@agnes/web-ui'

export const externalCompatibilityCatalog: LocaleCatalog = {
  en: {
    'skill.candidates.title': 'Choose a Skill',
    'skill.candidates.count': '{count} found',
    'skill.candidates.help': 'Choose one to review before installing. You can add other Skills later.',
    'skill.candidates.search': 'Search Skill name or path',
    'skill.candidates.select': 'Review {name}',
    'skill.candidates.check': 'Review',
    'skill.candidates.empty': 'No matching Skills. Try another name or path.',
    'mcp.import.selectionHelp':
      'MCP connections are optional and unchecked by default. Select only the ones you want to install, then apply and check your selection. Unselected connections are not registered or tested.',
    'mcp.import.emptySelection':
      'Select a Skill or an MCP connection to install. Nothing will be installed while the selection is empty.',
    'mcp.import.server.not-installed': 'Not installed',
    'mcp.import.warning.MCP_OPTIONAL_CONFIG_UNSUPPORTED':
      'The MCP configuration could not be imported safely. You can still install the available Skills and configure MCP separately.',
    'skill.import.reason.MCP_SELECTION_INVALID':
      'The selected MCP connection is not in this source. Check again before installing.',
    'skill.import.reason.MCP_SELECTION_CHANGED':
      'The MCP selection differs from the reviewed plan. Apply your selection and check again.',
    'skill.import.reason.MCP_SELECTION_REQUIRED':
      'Select at least one Skill or MCP connection before installing. Connection tests also require a selected connection.',

    'external.results.progress':
      'Processing capabilities: {success}/{total} have reached the requested state.',
    'external.results': 'Operation results',
    'external.results.complete': 'All {total} capabilities reached the requested state.',
    'external.results.partial':
      'Partially completed: {success}/{total} capabilities succeeded. Review failed or skipped items below.',
    'external.results.failed': 'No capabilities reached the requested state. Review the reasons below.',
    'external.outcome.succeeded': 'Succeeded',
    'external.outcome.failed': 'Failed',
    'external.outcome.skipped': 'Skipped',
    'external.retry': 'Check again and retry',
    'external.cancelOperation': 'Cancel remaining operations',
    'skill.import.reason.MCP_TRUST_REQUIRED':
      'This capability needs trust approval. Other reviewed capabilities can still be processed.',
    'skill.import.reason.MCP_CREDENTIAL_PERMISSION_REQUIRED':
      'Permission to use this connection’s credentials is missing. This connection was skipped.',
    'skill.import.reason.MCP_CAPABILITY_NOT_READY':
      'This capability did not reach the requested state. Check its individual status.',
    'skill.import.reason.MCP_NO_CAPABILITY_APPLIED':
      'No capabilities reached the requested state; see individual results.',

    'external.manageConnections': 'Manage MCP connection',
    'external.providerSetup':
      'AGH uses the provider’s declared MCP command or address. If it needs extra setup, follow the provider’s instructions and configure the installed command in Connections (MCP). AGH does not install dependencies, build source or emulate another harness.',
    'skill.import.reason.MCP_LOCAL_ENTRY_MISSING':
      'The declared local MCP entry file is missing. Obtain the provider’s runnable package and configure its command in Connections (MCP). Other reviewed Skills can still be enabled; instructions requiring this connection remain unavailable.',
    'skill.import.reason.MCP_RUNTIME_MANUAL_REQUIRED':
      'Automatic runtime preparation is no longer supported. Follow the provider’s setup instructions, then configure the runnable MCP command.',
    'skill.import.reason.MCP_RUNTIME_CHANGED':
      'Previously prepared files have changed. Review or reinstall the provider’s package before enabling it.',
  },
  'zh-CN': {
    'skill.candidates.title': '选择一个技能',
    'skill.candidates.count': '发现 {count} 个',
    'skill.candidates.help': '选择后查看内容并确认安装，其他技能可稍后继续添加。',
    'skill.candidates.search': '搜索技能名称或路径',
    'skill.candidates.select': '检查 {name}',
    'skill.candidates.check': '检查',
    'skill.candidates.empty': '没有匹配的技能，试试其他名称或路径。',
    'mcp.import.selectionHelp':
      'MCP 默认不选。请按需勾选要安装的连接，再应用并检查；未勾选的连接不会登记或测试。',
    'mcp.import.emptySelection': '请至少选择一个技能或 MCP 连接；没有选择时不会执行安装。',
    'mcp.import.server.not-installed': '未安装',
    'mcp.import.warning.MCP_OPTIONAL_CONFIG_UNSUPPORTED':
      'MCP 配置暂无法安全导入，可先安装可用技能，再单独配置 MCP。',
    'skill.import.reason.MCP_SELECTION_INVALID': '所选 MCP 连接不在当前来源中，请重新检查。',
    'skill.import.reason.MCP_SELECTION_CHANGED': 'MCP 选择与已审查计划不一致，请应用选择并重新检查。',
    'skill.import.reason.MCP_SELECTION_REQUIRED':
      '请至少选择一个技能或 MCP 连接再安装；测试连接也需要选中 MCP。',

    'external.results.progress': '正在逐项处理，{success}/{total} 项已达到目标状态。',
    'external.results': '操作结果',
    'external.results.complete': '全部 {total} 项能力已达到目标状态。',
    'external.results.partial': '部分完成：{success}/{total} 项成功，请查看下方失败或跳过原因。',
    'external.results.failed': '没有能力达到目标状态，请查看各项原因。',
    'external.outcome.succeeded': '成功',
    'external.outcome.failed': '失败',
    'external.outcome.skipped': '已跳过',
    'external.retry': '重新检查并重试',
    'external.cancelOperation': '取消后续操作',
    'skill.import.reason.MCP_TRUST_REQUIRED': '此项能力需要确认信任，其他已审查能力仍可继续处理。',
    'skill.import.reason.MCP_CREDENTIAL_PERMISSION_REQUIRED': '缺少使用此连接凭据的权限，已跳过该连接。',
    'skill.import.reason.MCP_CAPABILITY_NOT_READY': '此项能力尚未达到目标状态，请查看其单独状态。',
    'skill.import.reason.MCP_NO_CAPABILITY_APPLIED': '没有能力达到目标状态，请查看各项结果。',

    'external.manageConnections': '管理 MCP 连接',
    'external.providerSetup':
      'AGH 按提供方声明的 MCP 命令或地址连接。需要额外准备时，请按提供方说明安装，并在“连接（MCP）”中配置启动命令。AGH 不安装依赖、构建源码或模拟其他 Harness 运行时。',
    'skill.import.reason.MCP_LOCAL_ENTRY_MISSING':
      '缺少声明的本地 MCP 入口文件。请获取提供方的可运行包，并在“连接（MCP）”中配置启动命令；其他已审查技能仍可启用，依赖此连接的操作仍不可用。',
    'skill.import.reason.MCP_RUNTIME_MANUAL_REQUIRED':
      '已不支持自动准备运行环境。请按提供方说明手动安装，再配置可运行的 MCP 命令。',
    'skill.import.reason.MCP_RUNTIME_CHANGED': '此前准备的文件已变化，请审查或重新安装提供方程序后再启用。',
  },
}
