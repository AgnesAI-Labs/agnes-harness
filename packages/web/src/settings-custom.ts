import type {
  ConfigAccount,
  ConfigCustomModel,
  ConfigModel,
  ConfigTestInput,
  ConfigTestResult,
} from '@agnes/protocol'

/** The stable account dialog owns these fields; legacy fixtures may omit them. */
export function customConfigurationFields(provider: () => string, changed: () => void) {
  const input = (id: string) => document.getElementById(id) as HTMLInputElement | null
  const select = (id: string) => document.getElementById(id) as HTMLSelectElement | null
  const fields = document.getElementById('config-custom-fields')
  const custom = () => provider() === 'custom-openai'
  let discovered: string[] = [],
    imported: string[] = []
  const hint = (value: string) => {
    const field = document.getElementById('config-custom-catalogue-state')
    if (field) field.textContent = value
  }
  const catalogue = (ids: readonly string[]) => {
    const list = select('config-custom-discovered')
    if (!list) return
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = ids.length ? '选择目录中的模型' : '获取模型列表后可选择'
    list.replaceChildren(
      placeholder,
      ...ids.map((id) => {
        const option = document.createElement('option')
        option.value = id
        option.textContent = id
        return option
      }),
    )
  }
  const status = (state: 'untested' | 'stale' | 'testing' | 'passed' | 'failed', message: string) => {
    const panel = document.getElementById('config-custom-verification')
    if (panel) panel.dataset.state = state
    const title = document.getElementById('config-custom-verification-state')
    if (title) title.textContent = message
    document.getElementById('config-custom-verification-target')?.replaceChildren()
    document.getElementById('config-custom-verification-checks')?.replaceChildren()
    const hint = document.getElementById('config-custom-verification-hint')
    if (hint)
      hint.textContent =
        state === 'stale'
          ? '旧结果不再适用于当前配置，请重新测试。保存时会再次验证当前配置。'
          : '测试会调用默认模型，可能产生费用。保存时会再次验证当前配置。'
  }
  const protocol = () => {
    const responses = select('config-custom-api')?.value === 'openai-responses'
    const field = input('config-custom-system')
    if (field) field.disabled = responses
    const hint = document.getElementById('config-custom-system-hint')
    if (hint)
      hint.textContent = responses
        ? '当前 Responses 适配器不支持按历史顺序发送中途 system 消息，不能用于 JevLoop 的此项能力。普通推理仍可测试。'
        : '仅在网关契约或实现依据支持时勾选。测试只验证请求被接受，不证明消息未被合并或重排；JevLoop 还需要中途 system 请求测试通过。'
  }
  fields?.addEventListener('input', changed)
  fields?.addEventListener('change', () => {
    protocol()
    changed()
  })
  select('config-custom-discovered')?.addEventListener('change', () => {
    const model = input('config-custom-model')
    if (model) model.value = select('config-custom-discovered')?.value ?? ''
  })
  document.getElementById('config-custom-import')?.addEventListener('click', () => {
    imported = [...discovered]
    hint(
      `已导入 ${imported.length} 个模型 ID，均使用本页明确声明的能力和容量；只验证默认模型，其他模型尚未验证；尚未保存。`,
    )
    changed()
  })
  return {
    invalidate() {
      if (document.getElementById('config-custom-verification')?.dataset.state === 'untested') return
      status('stale', '配置已变更 · 请重新测试')
    },
    pending() {
      status('testing', '正在验证默认模型…')
    },
    failed() {
      status('failed', '测试未完成 · 请重试')
    },
    selectModel(id: string) {
      const model = input('config-custom-model')
      if (model) model.value = id
    },
    verification(result: ConfigTestResult) {
      const verification = result.customVerification
      const midSystemFailed = verification?.checks.some(
        (check) => check.id === 'mid-conversation-system' && check.status === 'failed',
      )
      status(
        result.verified ? 'passed' : 'failed',
        result.verified ? (midSystemFailed ? '普通推理通过 · 中途 system 未通过' : '测试通过') : '测试未通过',
      )
      if (!verification) return
      const target = document.getElementById('config-custom-verification-target')
      let endpoint = verification.baseUrl
      try {
        const url = new URL(endpoint)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        endpoint = url.href
      } catch {
        endpoint = '自定义端点'
      }
      if (target)
        target.textContent = `${verification.api === 'openai-completions' ? 'Chat Completions' : 'Responses'} · ${verification.model} · ${endpoint}`
      const reasons: Readonly<Record<string, string>> = {
        authentication: '认证失败，请检查密钥与权限',
        endpoint: '端点拒绝请求，请检查协议和地址',
        timeout: '请求超时，请重试',
        network: '网络请求失败，请检查连接',
        'invalid-response': '服务未返回有效模型输出',
        'unsupported-api': '当前协议不支持此消息结构',
      }
      const checks = document.getElementById('config-custom-verification-checks')
      checks?.replaceChildren(
        ...verification.checks.map((check) => {
          const item = document.createElement('li')
          item.dataset.state = check.status
          const label = check.id === 'inference' ? '普通推理' : '多轮中途 system 请求'
          const outcome = { passed: '通过', failed: '失败', skipped: '未执行' }[check.status]
          item.textContent = `${label}：${outcome}${check.reason ? ` · ${reasons[check.reason] ?? '请检查配置'}` : ''}`
          return item
        }),
      )
      const hint = document.getElementById('config-custom-verification-hint')
      if (hint)
        hint.textContent =
          '本次只验证默认模型的请求接受性，消息保序未验证。测试不会自动启用保序声明；保存时会再次验证。'
    },
    clearCatalogue() {
      discovered = []
      imported = []
      catalogue([])
      hint('修改连接后，请重新获取模型列表。')
    },
    setCatalogue(models: readonly ConfigModel[]) {
      discovered = models.map((model) => model.id)
      catalogue(discovered)
      const model = input('config-custom-model')
      if (model && !model.value) model.value = discovered[0] ?? ''
      const list = select('config-custom-discovered')
      if (list && model) list.value = model.value
      hint(`目录返回 ${discovered.length} 个模型 ID；不代表其容量、工具或图片能力已验证。`)
    },
    fill(account?: ConfigAccount) {
      discovered = []
      imported = [...(account?.custom?.modelIds ?? [])]
      catalogue(imported)
      hint(
        imported.length
          ? `已保存 ${imported.length} 个导入模型，均使用本页明确声明的能力和容量。`
          : '可手工填写模型 ID，或获取目录后导入。',
      )
      if (fields) fields.hidden = !custom()
      status('untested', '尚未测试')
      const model = input('config-custom-model')
      if (model) model.value = account?.model ?? ''
      const list = select('config-custom-discovered')
      if (list && model) list.value = model.value
      const saved = account?.custom
      for (const [id, value] of [
        ['config-custom-context', saved?.contextWindow ?? 32768],
        ['config-custom-output', saved?.maxTokens ?? 4096],
      ] as const) {
        const field = input(id)
        if (field) field.value = String(value)
      }
      const api = select('config-custom-api'),
        cap = select('config-custom-max-field')
      if (api) api.value = saved?.api ?? 'openai-completions'
      if (cap) cap.value = saved?.maxTokensField ?? 'max_tokens'
      for (const [id, checked] of [
        ['config-custom-system', saved?.supportsMidConvoSystemMessages ?? false],
        ['config-custom-tools', saved?.toolCalls ?? true],
        ['config-custom-image', saved?.input.includes('image') ?? false],
        ['config-custom-reasoning', saved?.reasoning ?? false],
      ] as const) {
        const field = input(id)
        if (field) field.checked = checked
      }
      protocol()
    },
    request(): Pick<ConfigTestInput, 'custom' | 'model'> {
      if (!custom()) return {}
      const model = input('config-custom-model')?.value.trim() ?? ''
      const contextWindow = Number(input('config-custom-context')?.value)
      const maxTokens = Number(input('config-custom-output')?.value)
      if (
        !model ||
        !Number.isSafeInteger(contextWindow) ||
        contextWindow < 1024 ||
        contextWindow > 10000000 ||
        !Number.isSafeInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > Math.min(contextWindow, 1000000)
      )
        throw new Error('请填写模型 ID、有效上下文容量和不超过容量的最大输出。')
      const declaration: ConfigCustomModel = {
        api:
          select('config-custom-api')?.value === 'openai-responses'
            ? 'openai-responses'
            : 'openai-completions',
        contextWindow,
        maxTokens,
        input: input('config-custom-image')?.checked ? ['text', 'image'] : ['text'],
        supportsMidConvoSystemMessages:
          select('config-custom-api')?.value !== 'openai-responses' &&
          (input('config-custom-system')?.checked ?? false),
        toolCalls: input('config-custom-tools')?.checked ?? false,
        reasoning: input('config-custom-reasoning')?.checked ?? false,
        maxTokensField:
          select('config-custom-max-field')?.value === 'max_completion_tokens'
            ? 'max_completion_tokens'
            : 'max_tokens',
        ...(imported.length ? { modelIds: [...imported] } : {}),
      }
      return { model, custom: declaration }
    },
    disable(disabled: boolean) {
      for (const field of fields?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        'input,select,button',
      ) ?? [])
        field.disabled =
          disabled ||
          (field.id === 'config-custom-import' && !discovered.length) ||
          (field.id === 'config-custom-discovered' && !discovered.length && !imported.length) ||
          (field.id === 'config-custom-system' && select('config-custom-api')?.value === 'openai-responses')
    },
  }
}
