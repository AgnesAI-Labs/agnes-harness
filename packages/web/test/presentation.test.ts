import { describe, expect, it } from 'vitest'
import { webLocaleCatalog } from '../src/locale-catalog.js'
import {
  canSubmitComposer,
  composerActionPresentation,
  composerHint,
  composerHintPresentation,
  errorNotice,
  isComposerSubmitShortcut,
  launcherCredential,
  modelSelectAccessibleName,
  modelSelectLabel,
  resizeComposer,
  setButtonLabel,
  shouldShowEmptyState,
  type Translate,
  workspaceErrorNotice,
} from '../src/presentation.js'

/** 断言目录结果：与 boot 同源的 zh-CN 目录 + LocaleService 同款插值。 */
const zhT: Translate = (key, vars) => {
  const template = webLocaleCatalog['zh-CN'][key] ?? webLocaleCatalog.en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
}

describe('web presentation controls', () => {
  it('grows the composer to its cap and makes overflow available after it', () => {
    const short = { scrollHeight: 72, style: { height: '', overflowY: '' } }
    resizeComposer(short)
    expect(short.style).toEqual({ height: '72px', overflowY: 'hidden' })

    const long = { scrollHeight: 252, style: { height: '', overflowY: '' } }
    resizeComposer(long)
    expect(long.style).toEqual({ height: '180px', overflowY: 'auto' })
  })

  it('uses a non-composing Enter as the send shortcut and keeps Shift+Enter for a newline', () => {
    const shortcut = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }
    expect(isComposerSubmitShortcut(shortcut)).toBe(true)
    const modifiedShortcut = { ...shortcut, metaKey: true, ctrlKey: true }
    expect(isComposerSubmitShortcut(modifiedShortcut)).toBe(true)
    expect(isComposerSubmitShortcut({ ...shortcut, shiftKey: true })).toBe(false)
    expect(isComposerSubmitShortcut({ ...shortcut, isComposing: true })).toBe(false)
    expect(isComposerSubmitShortcut({ ...shortcut, keyCode: 229 })).toBe(false)
    expect(isComposerSubmitShortcut({ ...shortcut, key: 'a' })).toBe(false)
  })

  it('states the available composer action without inventing a session or model', () => {
    expect(
      composerHint(
        {
          connected: false,
          configured: false,
          hasSession: false,
          busy: false,
          stopping: false,
          loading: false,
        },
        zhT,
      ),
    ).toContain('连接后台')
    expect(
      composerHint(
        {
          connected: true,
          configured: true,
          hasSession: true,
          busy: true,
          stopping: false,
          loading: false,
        },
        zhT,
      ),
    ).toBe('可补充下一轮')
    expect(
      composerHint(
        {
          connected: true,
          configured: true,
          hasSession: true,
          busy: false,
          stopping: false,
          loading: false,
        },
        zhT,
      ),
    ).toBe('Enter 发送，Shift+Enter 换行')
    expect(modelSelectLabel(undefined, zhT)).toBe('选择模型')
    expect(modelSelectLabel({ route: 'openai', id: 'gpt-5.6' }, zhT)).toBe('gpt-5.6')
    expect(modelSelectAccessibleName({ route: 'account-acct-private', id: 'gpt-5.6' }, zhT)).toBe(
      '当前会话模型：gpt-5.6',
    )
  })

  it('separates visual composer modes from their accessible action names', () => {
    expect(composerActionPresentation({ busy: false, loading: false, sending: false }, zhT)).toEqual({
      mode: 'idle',
      label: '发送',
      title: '发送（Enter）',
    })
    expect(composerActionPresentation({ busy: true, loading: false, sending: false }, zhT)).toEqual({
      mode: 'busy',
      label: '加入下一轮',
      title: '加入下一轮（Enter）',
    })
    expect(composerActionPresentation({ busy: true, loading: false, sending: true }, zhT)).toEqual({
      mode: 'pending',
      label: '正在提交…',
      title: '正在提交…',
    })
    expect(
      composerHintPresentation(
        {
          connected: true,
          configured: true,
          hasSession: true,
          busy: false,
          stopping: false,
          loading: false,
        },
        zhT,
      ),
    ).toEqual({ kind: 'shortcut', text: 'Enter 发送，Shift+Enter 换行' })
    expect(
      composerHintPresentation(
        {
          connected: true,
          configured: true,
          hasSession: true,
          busy: true,
          stopping: false,
          loading: false,
        },
        zhT,
      ),
    ).toEqual({ kind: 'state', text: '可补充下一轮' })
  })

  it('blocks prompt submission while a session transition is pending', () => {
    expect(
      composerHint(
        {
          connected: true,
          configured: true,
          hasSession: true,
          busy: false,
          stopping: false,
          loading: true,
        },
        zhT,
      ),
    ).toBe('正在准备…')
    expect(
      canSubmitComposer({
        connected: true,
        hasSession: true,
        sending: false,
        stopping: false,
        loading: true,
      }),
    ).toBe(false)
    expect(
      canSubmitComposer({
        connected: true,
        hasSession: true,
        sending: false,
        stopping: false,
        loading: false,
      }),
    ).toBe(true)
  })

  it('shows the empty state whenever this session has no messages', () => {
    // 2026-09-17：判据由"必须已收到 projection 且为空"放宽为"没有任何消息"。
    // 原因：projection 未到时 hero 不渲染，而输入卡上方的文案（判据是会话区为空）
    // 已经出现，两处条件不一致 —— 用户看到"只有新文案、没有 AGH/Agnes Harness/副标题"。
    expect(shouldShowEmptyState(undefined)).toBe(true)
    expect(shouldShowEmptyState([])).toBe(true)
    expect(shouldShowEmptyState([{}])).toBe(false)
  })

  it('keeps an existing navigation target out of launcher credential handling', () => {
    const hasNavigationTarget = (id: string) => id === 'main-content'
    expect(launcherCredential('#main-content', hasNavigationTarget)).toBeUndefined()
    expect(launcherCredential('#custom-token', hasNavigationTarget)).toBe('custom-token')
    const customToken = 'opaque-token-with-a-custom-length'
    expect(launcherCredential(`#${customToken}`, hasNavigationTarget)).toBe(customToken)
    expect(launcherCredential('', hasNavigationTarget)).toBeUndefined()
  })

  it('uses neutral copy for the generic backend failure without guessing its cause', () => {
    expect(errorNotice('INTERNAL_ERROR (-32603)', undefined, undefined, undefined, undefined, zhT)).toBe(
      '后台未能完成请求，请稍后重试。',
    )
    const id = '12345678-1234-1234-1234-123456789abc'
    expect(errorNotice('INTERNAL_ERROR (-32603)', id, undefined, undefined, undefined, zhT)).toContain(
      `诊断编号：${id}`,
    )
    expect(errorNotice('INTERNAL_ERROR (-32603)', '<script>secret</script>', undefined, undefined, undefined, zhT)).toBe(
      '后台未能完成请求，请稍后重试。',
    )
    expect(errorNotice('normal error', id, undefined, undefined, undefined, zhT)).toBe('normal error')
    // A session an older build wrote: said plainly, with no diagnostic wording to chase.
    const legacy = errorNotice('SEMANTIC_REJECTED (-32011)', id, undefined, undefined, 'legacy-ledger-format', zhT)
    expect(legacy).toBe('该会话由旧版本创建，当前版本无法打开，请新建会话。')
    expect(legacy).not.toContain('诊断')
    expect(errorNotice('SEMANTIC_REJECTED (-32011)', id, undefined, undefined, 'other', zhT)).toBe(
      'SEMANTIC_REJECTED (-32011)',
    )
    expect(errorNotice('INTERNAL_ERROR (-32603)', undefined, true, undefined, undefined, zhT)).toContain(
      '诊断记录未能保存',
    )
    expect(errorNotice('INTERNAL_ERROR (-32603)', id, true, undefined, undefined, zhT)).not.toContain(id)
    expect(errorNotice('INTERNAL_ERROR (-32603)', undefined, undefined, 'AUTH', undefined, zhT)).toBe(
      '模型凭据已失效或被上游拒绝，请在设置中重新配置或登录该模型账号。',
    )
    expect(errorNotice('INTERNAL_ERROR (-32603)', undefined, undefined, 'UNKNOWN', undefined, zhT)).toBe(
      '后台未能完成请求，请稍后重试。',
    )
    expect(errorNotice('INTERNAL_ERROR (-32603)', undefined, undefined, 'OUTPUT_LIMIT', undefined, zhT)).toBe(
      '模型回复达到输出额度，本轮已停止。请要求分步生成，或调整请求输出额度后继续。',
    )
    expect(errorNotice('INTERNAL_ERROR (-32603)', undefined, undefined, 'RATE_LIMIT', undefined, zhT)).toBe(
      '模型服务返回限流错误（HTTP 429）。请稍后重试；若持续出现，请检查该账号的服务额度或联系模型服务方。',
    )
    expect(errorNotice('配置已被其他客户端修改，请重新打开设置后再试。', undefined, undefined, undefined, undefined, zhT)).toBe(
      '配置已被其他客户端修改，请重新打开设置后再试。',
    )
  })

  it('maps workspace validation reasons and hides raw RPC fallbacks', () => {
    expect(
      workspaceErrorNotice({ data: { code: 'WORKSPACE_INVALID', reason: 'not-found' } }, zhT),
    ).toBe('工作目录不存在，请检查路径后重试。')
    expect(workspaceErrorNotice(new Error('SEMANTIC_REJECTED (-32011)'), zhT)).toBe(
      '无法使用此工作目录，请检查路径是否存在及访问权限。',
    )
  })

  it('changes a control label without removing an inline icon', () => {
    const label = { textContent: '发送' }
    const button = { textContent: 'icon 发送', querySelector: () => label } as unknown as HTMLButtonElement
    setButtonLabel(button, '正在提交…')
    expect(label.textContent).toBe('正在提交…')
    expect(button.textContent).toBe('icon 发送')

    const legacy = { textContent: '发送', querySelector: () => null } as unknown as HTMLButtonElement
    setButtonLabel(legacy, '加入下一轮')
    expect(legacy.textContent).toBe('加入下一轮')
  })
})
