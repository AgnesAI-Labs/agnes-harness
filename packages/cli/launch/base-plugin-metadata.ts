import type { AgnesPluginManifestEntry } from '@agnes/package-manager'

// Static SEA metadata; packaged-host.test.ts checks equality with the normalized author manifest.
export const AGNES_BASE_PLUGIN_METADATA: Readonly<
  Record<string, NonNullable<AgnesPluginManifestEntry['metadata']>>
> = {
  'tool-policy:default': {
    displayName: 'Approval rules',
    summary: 'Decides which tool actions need approval under the selected session policy.',
    description: 'Decides which tool actions need approval under the selected session policy.',
    category: 'safety-approval',
    locales: {
      'zh-CN': {
        displayName: '审批规则',
        summary: '按会话策略判断哪些工具操作需要先获得批准。',
        description: '按会话策略判断哪些工具操作需要先获得批准。',
      },
    },
  },
  'observability:otel': {
    displayName: 'Task telemetry',
    summary: 'Exports configured task telemetry to help operators diagnose execution and usage.',
    description: 'Exports configured task telemetry to help operators diagnose execution and usage.',
    category: 'observability',
    locales: {
      'zh-CN': {
        displayName: '任务遥测',
        summary: '导出已配置的任务遥测，帮助运维人员诊断执行与用量。',
        description: '导出已配置的任务遥测，帮助运维人员诊断执行与用量。',
      },
    },
  },
  'seam:approval': {
    displayName: 'Approval rules',
    summary: 'Decides which tool actions need approval under the selected session policy.',
    description: 'Decides which tool actions need approval under the selected session policy.',
    category: 'safety-approval',
    locales: {
      'zh-CN': {
        displayName: '审批规则',
        summary: '按会话策略判断哪些工具操作需要先获得批准。',
        description: '按会话策略判断哪些工具操作需要先获得批准。',
      },
    },
  },
  'seam:principals': {
    displayName: 'Local machine owner',
    summary: 'Treats callers as one local machine owner for single-user deployments.',
    description: 'Treats callers as one local machine owner for single-user deployments.',
    category: 'safety-approval',
    locales: {
      'zh-CN': {
        displayName: '本机所有者',
        summary: '在单用户部署中，将调用方统一视为本机所有者。',
        description: '在单用户部署中，将调用方统一视为本机所有者。',
      },
    },
  },
  'seam:artifacts': {
    displayName: 'Local artifacts',
    summary: 'Stores tool outputs and attachments locally so they can be retrieved later.',
    description: 'Stores tool outputs and attachments locally so they can be retrieved later.',
    category: 'developer',
    locales: {
      'zh-CN': {
        displayName: '本地附件存储',
        summary: '在本地保存工具产物和附件，便于之后查看与取回。',
        description: '在本地保存工具产物和附件，便于之后查看与取回。',
      },
    },
  },
  'seam:checkpoint': {
    displayName: 'File checkpoints',
    summary: 'Saves file checkpoints so supported workspace changes can be inspected and rewound.',
    description: 'Saves file checkpoints so supported workspace changes can be inspected and rewound.',
    category: 'safety-approval',
    locales: {
      'zh-CN': {
        displayName: '文件检查点',
        summary: '保存文件检查点，便于检查和回退受支持的工作区改动。',
        description: '保存文件检查点，便于检查和回退受支持的工作区改动。',
      },
    },
  },
  'seam:ledger': {
    displayName: 'Usage accounting',
    summary: "Records model usage and cost estimates to help track a task's spending.",
    description: "Records model usage and cost estimates to help track a task's spending.",
    category: 'observability',
    locales: {
      'zh-CN': {
        displayName: '用量记录',
        summary: '记录模型用量与费用估算，帮助掌握任务开销。',
        description: '记录模型用量与费用估算，帮助掌握任务开销。',
      },
    },
  },
  'seam:verifier': {
    displayName: 'Progress checks',
    summary:
      'Detects repeated writes and stalled work, then requests revision or escalation within configured limits.',
    description:
      'Detects repeated writes and stalled work, then requests revision or escalation within configured limits.',
    category: 'agent-loop',
    locales: {
      'zh-CN': {
        displayName: '执行进度检查',
        summary: '发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。',
        description: '发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。',
      },
    },
  },
  'seam:repair': {
    displayName: 'Progress checks',
    summary:
      'Detects repeated writes and stalled work, then requests revision or escalation within configured limits.',
    description:
      'Detects repeated writes and stalled work, then requests revision or escalation within configured limits.',
    category: 'agent-loop',
    locales: {
      'zh-CN': {
        displayName: '执行进度检查',
        summary: '发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。',
        description: '发现重复写入和停滞的执行，并按配置限制要求修正或升级处理。',
      },
    },
  },
  'seam:harness': {
    displayName: 'Reviewed improvements',
    summary:
      'Lets the agent propose evidence-backed changes to prompts, memory, Skills and child-agent definitions.',
    description:
      'Lets the agent propose evidence-backed changes to prompts, memory, Skills and child-agent definitions.',
    category: 'memory-context',
    locales: {
      'zh-CN': {
        displayName: '改进提案',
        summary: '让 Agent 根据执行证据提出提示、记忆、技能和子 Agent 定义的改进建议。',
        description: '让 Agent 根据执行证据提出提示、记忆、技能和子 Agent 定义的改进建议。',
      },
    },
  },
  'loop:agnes.default': {
    displayName: 'Default Agent Loop',
    summary: 'Runs the default agent workflow through model calls, tools, approvals and continuation.',
    description: 'Runs the default agent workflow through model calls, tools, approvals and continuation.',
    category: 'agent-loop',
    locales: {
      'zh-CN': {
        displayName: '默认 Agent Loop',
        summary: '通过模型调用、工具、审批与续接执行默认 Agent 工作流。',
        description: '通过模型调用、工具、审批与续接执行默认 Agent 工作流。',
      },
    },
  },
  'child-agent:codex': {
    displayName: 'Codex child agents',
    summary: 'Uses a configured Codex process to handle delegated coding tasks.',
    description: 'Uses a configured Codex process to handle delegated coding tasks.',
    category: 'collaboration',
    locales: {
      'zh-CN': {
        displayName: 'Codex 子 Agent',
        summary: '使用已配置的 Codex 进程处理分派的编程任务。',
        description: '使用已配置的 Codex 进程处理分派的编程任务。',
      },
    },
  },
  'child-agent:claude-code': {
    displayName: 'Claude Code child agents',
    summary: 'Uses a configured Claude Code process to handle delegated coding tasks.',
    description: 'Uses a configured Claude Code process to handle delegated coding tasks.',
    category: 'collaboration',
    locales: {
      'zh-CN': {
        displayName: 'Claude Code 子 Agent',
        summary: '使用已配置的 Claude Code 进程处理分派的编程任务。',
        description: '使用已配置的 Claude Code 进程处理分派的编程任务。',
      },
    },
  },
  'child-agent:sdk': {
    displayName: 'Built-in child agents',
    summary: "Runs delegated tasks in child sessions through AGH's built-in agent engine.",
    description: "Runs delegated tasks in child sessions through AGH's built-in agent engine.",
    category: 'collaboration',
    locales: {
      'zh-CN': {
        displayName: '内置子 Agent',
        summary: '通过 AGH 内置 Agent 引擎，在子会话中执行分派的任务。',
        description: '通过 AGH 内置 Agent 引擎，在子会话中执行分派的任务。',
      },
    },
  },
  'memory:file': {
    displayName: 'Workspace memory',
    summary:
      'Keeps reviewed workspace preferences in local files for later sessions, with agent access off by default.',
    description:
      'Keeps reviewed workspace preferences in local files for later sessions, with agent access off by default.',
    category: 'memory-context',
    locales: {
      'zh-CN': {
        displayName: '工作区记忆',
        summary: '在本地文件中保留经审核的工作区偏好供后续会话使用，默认关闭 Agent 访问。',
        description: '在本地文件中保留经审核的工作区偏好供后续会话使用，默认关闭 Agent 访问。',
      },
    },
  },
  'skills:remembering': {
    displayName: 'Remembering playbook',
    summary: 'Supplies a reusable playbook for reviewing and recording workspace preferences.',
    description: 'Supplies a reusable playbook for reviewing and recording workspace preferences.',
    category: 'memory-context',
    locales: {
      'zh-CN': {
        displayName: '偏好记忆手册',
        summary: '提供用于审核和记录工作区偏好的可复用操作手册。',
        description: '提供用于审核和记录工作区偏好的可复用操作手册。',
      },
    },
  },
  'reference-resolvers:default': {
    displayName: 'Conversation references',
    summary: 'Resolves supported file and session references attached to a conversation.',
    description: 'Resolves supported file and session references attached to a conversation.',
    category: 'memory-context',
    locales: {
      'zh-CN': {
        displayName: '对话引用',
        summary: '解析对话中附带的受支持文件与会话引用。',
        description: '解析对话中附带的受支持文件与会话引用。',
      },
    },
  },
}
