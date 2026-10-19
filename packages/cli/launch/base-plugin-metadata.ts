import type { AgnesPluginManifestEntry } from '@agnes/package-manager'

// Static SEA metadata; packaged-host.test.ts checks equality with the normalized author manifest.
export const AGNES_BASE_PLUGIN_METADATA: Readonly<
  Record<string, NonNullable<AgnesPluginManifestEntry['metadata']>>
> = {
  'tool-policy:default': {
    displayName: 'Approval rules',
    summary: 'Decides which tool actions need approval under the selected session policy.',
    description: 'Decides which tool actions need approval under the selected session policy.',
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
    locales: {
      'zh-CN': {
        displayName: '任务遥测',
        summary: '导出已配置的任务遥测，帮助运维人员诊断执行与用量。',
        description: '导出已配置的任务遥测，帮助运维人员诊断执行与用量。',
      },
    },
  },
  'seam-providers:default': {
    displayName: 'Core runtime services',
    summary:
      'Provides the default approval prompts, identity, usage accounting, checkpoints, artifact storage and progress checks.',
    description:
      'Provides the default approval prompts, identity, usage accounting, checkpoints, artifact storage and progress checks.',
    locales: {
      'zh-CN': {
        displayName: '核心运行服务',
        summary: '提供默认的审批提示、身份、用量记录、文件检查点、产物存储和进度检查。',
        description: '提供默认的审批提示、身份、用量记录、文件检查点、产物存储和进度检查。',
      },
    },
  },
  'loop:agnes.default': {
    displayName: 'Default Agent Loop',
    summary: 'Runs the default agent workflow through model calls, tools, approvals and continuation.',
    description: 'Runs the default agent workflow through model calls, tools, approvals and continuation.',
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
    locales: {
      'zh-CN': {
        displayName: '偏好记忆手册',
        summary: '提供用于审核和记录工作区偏好的可复用操作手册。',
        description: '提供用于审核和记录工作区偏好的可复用操作手册。',
      },
    },
  },
  'service:plan-mode': {
    displayName: 'Plan mode controls',
    summary: 'Provides shared plan mode controls for Web and terminal clients.',
    description: 'Provides shared plan mode controls for Web and terminal clients.',
    locales: {
      'zh-CN': {
        displayName: '计划模式控制',
        summary: '为 Web 和终端客户端提供共享的计划模式控制。',
        description: '为 Web 和终端客户端提供共享的计划模式控制。',
      },
    },
  },
  'reference-resolvers:default': {
    displayName: 'Conversation references',
    summary: 'Resolves supported file and session references attached to a conversation.',
    description: 'Resolves supported file and session references attached to a conversation.',
    locales: {
      'zh-CN': {
        displayName: '对话引用',
        summary: '解析对话中附带的受支持文件与会话引用。',
        description: '解析对话中附带的受支持文件与会话引用。',
      },
    },
  },
}
