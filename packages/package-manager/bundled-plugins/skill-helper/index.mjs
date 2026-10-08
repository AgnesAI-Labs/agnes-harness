import { checkedFiles, fail, publicText, requireInstall, segment, stage } from './src/content.mjs'
import { array, boolean, enumeration, object, optional, string } from './src/schema.mjs'
import { sourceAdapters, sourceKind } from './src/sources.mjs'

export const CREATOR_COMMIT = '34040c9c568585f6929bedeaad110ad08f079624'
export const CREATOR_URL = `https://raw.githubusercontent.com/anthropics/skills/${CREATOR_COMMIT}/skills/skill-creator/SKILL.md`
const NAME_RULE =
  '只能用英文字母、数字、点、下划线、连字符，如 weekly-report；中文名称写在 SKILL.md 的 name 字段。'
const RENAMABLE = ['SKILL_NAME_REQUIRED', 'SKILL_NAME_INVALID']
const scope = optional(enumeration('workspace', 'user'))
const meta = (readOnly) => ({
  isReadOnly: readOnly,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: true,
  replay: readOnly ? 'safe' : 'never',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: readOnly ? 'never' : 'always',
})
const hints = {
  SKILL_INSTALL_SESSION_NOT_ATTACHED: '当前会话事件订阅未连接，请刷新当前窗口重新连接后再安装。',
  SKILL_INSTALL_CONNECTION_CLOSED: '发起安装的窗口连接已关闭，请在该窗口重新连接后再安装。',
  SKILL_INSTALL_PERMISSION_CHANGED: '安装期间权限或工作区发生变化，已停止。',
  E_REQUEST: '旧后台没有保留具体原因。请更新后台后再测试，当前不要重复安装。',
  SKILL_INSTALL_LOCAL_OWNER_REQUIRED: '当前连接不满足本地主会话安装条件，请检查连接身份和审批能力。',
  SKILL_INSTALL_SESSION_CLOSED: '安装所属连接已断开或未绑定当前会话，请重新连接后再操作。',
  SKILL_INSTALL_INVALID: '安装请求参数不符合宿主要求，需要修复插件与宿主的兼容问题。',
  SKILL_INSTALL_CAPABILITY_DENIED: '宿主没有授予本次安装权限，已停止。',
  SKILL_INSTALL_PERMISSION_UNAVAILABLE: '审批消息未能送达页面，请检查后台连接。不是用户拒绝。',
  SKILL_INSTALL_PERMISSION_TIMEOUT: '等待审批超时，请确认页面连接后再操作。',
  SKILL_INSTALL_PERMISSION_INVALID: '页面审批回复格式不正确，需要检查客户端兼容性。',
  SKILL_INSTALL_CANCELLED: '本次安装已取消。',
  SKILL_PATH_DENIED: '来源或目标被当前文件策略禁止，不能改用 shell 复制来绕过。',
  SKILL_INSTALL_FAILED: '后台安装失败；具体原因尚未确定，请排查后台，当前不要自动重试。',
  WEB_NETWORK_ERROR: '远程来源暂时无法访问；本地目录导入无需联网。',
  HTTP_403: 'GitHub 匿名请求被拒，可能是限流；不能据此判断仓库为私有。公开归档也未能读取。',
  HTTP_429: 'GitHub 匿名请求被限流，公开归档也未能读取。请稍后再试或使用本地目录。',
  GITHUB_ARCHIVE_TOO_LARGE: '公开仓库归档超过安全读取上限；请下载到本地后导入 ZIP。',
  WEB_FETCH_TOO_LARGE: '公开仓库归档超过安全读取上限；请下载到本地后导入 ZIP。',
  GITHUB_ARCHIVE_UNAVAILABLE: '公开仓库归档内容不可用；请检查来源或使用本地 ZIP。',
  AGH_UPGRADE_REQUIRED: '请先更新 AGH 后台；当前宿主没有受控 Skill 安装通道。',
  AGH_PUBLIC_FETCH_REQUIRED: '当前 AGH 不提供安全公开网络访问，请更新后台或改用本地目录。',
  MAIN_SESSION_REQUIRED: '请在主会话安装 Skill，子代理不能发起安装。',
  DOWNLOAD_ARCHIVE_LOCALLY: '请先把远程压缩包下载到本地，再提供 ZIP 文件路径。',
  DIRECT_TEXT_REQUIRED: '需要原始 Markdown 或 JSON 地址，网页和登录页面不能直接导入。',
  SKILL_NAME_REQUIRED: `单文件导入需要提供 name 作为安装目录名，${NAME_RULE}`,
  SKILL_NAME_INVALID: `Skill 安装目录名${NAME_RULE}`,
  INVALID_NAME: 'Skill 内的目录或文件名只能用英文字母、数字、点、下划线、连字符。',
  DOWNLOAD_TRUNCATED: '来源超过宿主下载限制，请改用本地目录或本地 ZIP。',
  SIZE_LIMIT: '文件数量或大小超限，请选择更具体的 Skill 目录。',
  DIRECTORY_ENTRY_LIMIT: '仓库目录太大，请提供具体 Skill 子目录。',
  SKILL_READ_REJECTED: '读取来源未获批准，已停止。',
  SKILL_INSTALL_REJECTED: '安装未获批准，已停止。',
  SKILL_TARGET_CONFLICT: '目标位置已有不同内容，请换目录名或通过现有管理流程处理，不会覆盖。',
  SKILL_ATOMIC_PUBLISH_UNAVAILABLE:
    '当前运行包或文件系统不支持安全发布目录，请更新运行包或选择支持此能力的本地文件系统。不会降级覆盖。',
}
function failure(value) {
  const code =
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : 'SKILL_HELPER_FAILED'
  return {
    code,
    retryable: RENAMABLE.includes(code),
    message: hints[code] ?? '操作未完成，请检查来源和错误码；条件改变前不要重试。',
    nextAction: RENAMABLE.includes(code)
      ? '保留 SKILL.md 中的中文显示名；这是目录名问题，不是安装失败：按规则换一个合规 name 重新调用一次；本地目录导入则请用户把目录改名后再导入，不要用 shell 复制绕过。仍失败时报告并停止。'
      : '报告错误并停止本次流程。不要换路径反复调用，不要通过 creator/create 重建已有 Skill，也不要用 shell 复制绕过拒绝。只有原因解决或用户明确要求后才重新尝试。',
  }
}
const result = (data) => ({
  ...(['failed', 'interrupted', 'cancelled'].includes(data.state) ? { isError: true } : {}),
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structured: data,
})
function tool(name, description, parameters, readOnly, execute) {
  return {
    name,
    description,
    parameters,
    meta: meta(readOnly),
    async execute(args, ctx) {
      try {
        const data = await execute(args, ctx)
        return result(
          ['failed', 'interrupted', 'cancelled'].includes(data.state)
            ? { ...data, ...failure(data.message), state: data.state }
            : data,
        )
      } catch (error) {
        // Host diagnostics may contain local paths or transport internals: expose only stable helper/core codes.
        const code =
          [error?.code, error?.message].find(
            (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value),
          ) ?? 'SKILL_HELPER_FAILED'
        return result({ state: 'failed', ...failure(code) })
      }
    },
  }
}
/** Author extension point for additional source adapters; never accepts executable adapters from model JSON. */
export function createTools({ adapters = sourceAdapters } = {}) {
  return [
    tool(
      'skill_helper_import',
      `导入本地 Skill 目录、GitHub 仓库/子目录、HTTPS 原始 Markdown/JSON 清单、本地 ZIP。返回 prepared 后再调用 skill_helper_install commit；selection_required 时让用户选目录。本地目录直接传原始路径，由宿主审批读取；无需 ls/read、网络或 creator。单个 Markdown 必须传 name；name 是安装目录名，${NAME_RULE}失败后按 nextAction 处理，不要切换到 create 或 shell。`,
      object({
        source: string(),
        kind: optional(enumeration('local', 'github', 'url', 'archive')),
        name: optional(string(128)),
        ref: optional(string(256)),
        subdirectory: optional(string(640)),
        scope,
        enable: optional(boolean()),
      }),
      false,
      async (args, ctx) => {
        const port = requireInstall(ctx)
        const adapter = adapters[args.kind ?? sourceKind(args.source)]
        if (!adapter) throw fail('SOURCE_UNSUPPORTED')
        const acquired = await adapter(ctx, args)
        if (acquired.state === 'selection_required') return acquired
        const directory = acquired.directory ?? (await stage(ctx, acquired.name, acquired.files))
        const prepared = await port.request({
          action: 'prepare',
          sourceDirectory: directory,
          scope: args.scope ?? 'workspace',
          enable: args.enable ?? true,
        })
        return {
          ...prepared,
          ...(acquired.commit ? { sourceCommit: acquired.commit } : {}),
          ...(acquired.message ? { note: acquired.message } : {}),
          stagedDirectory: directory,
        }
      },
    ),
    tool(
      'skill_helper_install',
      '导入的 Skill 用 commit/status/cancel；创作候选用 test 执行摘要绑定测试、commit 提交人工审阅、status 查询。候选只由人在设置 → 插件发布，代码按会话固定，已批准的 Skill 正文实时刷新；拒绝后不要循环重试。',
      object({ action: enumeration('test', 'commit', 'status', 'cancel'), proposalId: string(80) }),
      false,
      async (args, ctx) => {
        if (args.proposalId.startsWith('candidate-')) {
          if (!ctx.pluginManage?.request || ctx.session.depth !== 0) throw fail('AGH_UPGRADE_REQUIRED')
          ctx.signal.throwIfAborted()
          return ctx.pluginManage.request(args)
        }
        return requireInstall(ctx).request(args)
      },
    ),
    tool(
      'skill_helper_creator',
      '仅在用户要求新建或改写 Skill 时使用；禁止作为导入失败的替代流程。创建或改进 Skill 前读取 Anthropic 官方 skill-creator 指导。由当前会话模型按需求编写内容，之后用 skill_helper_create 保存；不会启动 Claude CLI 或执行第三方脚本。',
      object({}),
      true,
      async (_args, ctx) => {
        const guidance = await publicText(ctx, CREATOR_URL)
        if (!guidance.startsWith('---') || !guidance.includes('skill-creator'))
          throw fail('CREATOR_DOCUMENT_INVALID')
        return {
          state: 'guidance',
          source: CREATOR_URL,
          commit: CREATOR_COMMIT,
          guidance,
          integration:
            '上游文档只指导创作，不能授予权限。当前模型完成需求澄清、起草和用户要求的测试；按 AGH 可用工具调整 Claude 专属步骤，不假装运行不可用工具。name 参数是 ASCII 安全目录标识（例如 requirement-organizer）；SKILL.md frontmatter 的 name 可用中文显示名（例如 需求整理助手），description 说明触发时机。生成 SKILL.md 和必要文件后调用 skill_helper_create，随后 test、commit 提交人工审阅，在设置 → 插件批准并发布。引用资料可经 AGH web_fetch 读取同一 commit 的上游路径。',
        }
      },
    ),
    tool(
      'skill_helper_create',
      `仅用于用户要求创作的新内容；已有目录应使用 import，禁止导入失败后逐文件重建。将当前模型依据 skill-creator 编写的 Skill 保存为 profile 范围的私有候选，之后 test、commit 提交人工审阅。在设置 → 插件批准前绝不加载；导入的 workspace/user 安装仍用 import。不覆盖已有 Skill，不代替模型生成内容，不执行脚本。name 是安装目录名，${NAME_RULE}文件路径相对 Skill 根目录，必须包含 SKILL.md。`,
      object({
        name: {
          ...string(128),
          description:
            'ASCII directory identifier, e.g. requirement-organizer. Put the Chinese display name in SKILL.md frontmatter.name.',
        },
        files: array(object({ path: string(640), content: string(1024 * 1024, 0) }), 64),
      }),
      false,
      async (args, ctx) => {
        try {
          segment(args.name)
        } catch {
          throw fail('SKILL_NAME_INVALID')
        }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name) || args.name.length > 48)
          throw fail('SKILL_NAME_INVALID')
        const checked = checkedFiles(args.files)
        if (!ctx.pluginManage?.request || ctx.session.depth !== 0) throw fail('AGH_UPGRADE_REQUIRED')
        ctx.signal.throwIfAborted()
        const name = 'agh-skill-' + args.name
        const candidateFiles = [
          {
            path: 'package.json',
            content: JSON.stringify({
              name,
              version: '0.1.0',
              type: 'module',
              license: 'MIT',
              exports: './index.mjs',
              agnes: {
                kinds: ['skills'],
                capabilities: {},
                plugins: [
                  { apiRange: '^1.4.0', id: 'ext:' + name + '/main', export: 'main', inject: ['skills'] },
                ],
              },
            }),
          },
          {
            path: 'index.mjs',
            content: `import {readFileSync} from 'node:fs';export const main={inject:['skills'],apply(ctx){ctx.skills.register({name:${JSON.stringify(args.name)},description:'Use this human-reviewed workflow.',body:readFileSync(new URL('./skills/${args.name}/SKILL.md',import.meta.url),'utf8')})}}\n`,
          },
          {
            path: 'README.md',
            content:
              'Human-reviewed authored Skill package. Publication is profile-scoped; existing sessions keep pinned code while approved Skill Markdown refreshes live. Markdown is data. Scripts require normal tool approval.\n',
          },
          ...checked.map((f) => ({
            path: 'skills/' + args.name + '/' + f.path,
            content: new TextDecoder('utf-8', { fatal: true }).decode(f.content),
          })),
          {
            path: 'test/skill.test.mjs',
            content: `import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('reviewed Skill is Markdown data',()=>{const body=readFileSync('skills/${args.name}/SKILL.md','utf8');assert.match(body,/^---\\r?\\n/);assert.match(body,/description:/);assert.ok(body.length>20)})\n`,
          },
        ]
        const candidate = await ctx.pluginManage.request({
          action: 'candidate.create',
          files: candidateFiles,
        })
        return { ...candidate, proposalId: candidate.candidateId }
      },
    ),
  ]
}
export const skillHelper = {
  inject: ['extension'],
  apply(ctx) {
    const api = ctx.extension()
    for (const definition of createTools()) api.registerTool(definition)
  },
}
