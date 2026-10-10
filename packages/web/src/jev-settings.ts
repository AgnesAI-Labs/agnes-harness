import type { JevConfigSnapshot, JevSettings } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'

/** Listeners belong to the stable shell, not to a replaceable settings pane. */
export function createJevSettingsController(client: Client, onSaved?: () => Promise<void>) {
  const shell = document.getElementById('config')
  let snapshot: JevConfigSnapshot | undefined
  let connected = true,
    busy = false,
    generation = 0
  let testedKey: string | undefined
  let activeBackend: 'jev' | 'laya' = 'jev'
  const targetFields = [
    'jev-transport',
    'jev-account',
    'jev-endpoint',
    'jev-model',
    'jev-auth',
    'jev-decision-credits',
    'jev-language-credits',
  ]
  const drafts = new Map<string, { values: string[]; enabled: boolean }>()
  const savedDraft = (settings: JevSettings) => ({
    values: [
      settings.transport,
      settings.accountId ?? '',
      settings.endpoint,
      settings.model,
      settings.authentication,
      String(settings.decisionRequestCredits ?? ''),
      String(settings.languageRequestCredits ?? ''),
    ],
    enabled: settings.enabled,
  })
  const input = (id: string) => document.getElementById(id) as HTMLInputElement | null
  const select = (id: string) => document.getElementById(id) as HTMLSelectElement | null
  const text = (id: string, value: string) => {
    const field = document.getElementById(id)
    if (field) field.textContent = value
  }
  const clearKey = () => {
    testedKey = undefined
    const key = input('jev-key')
    if (key) key.value = ''
  }
  const render = () => {
    const laya = select('jev-backend')?.value === 'laya'
    const transport = select('jev-transport')
    if (laya && transport) transport.value = 'native'
    const cloudflare = transport?.value === 'cloudflare'
    document.getElementById('jev-account-field')?.toggleAttribute('hidden', !cloudflare)
    const endpoint = input('jev-endpoint'),
      auth = select('jev-auth')
    if (cloudflare) {
      if (endpoint)
        endpoint.value = `https://api.cloudflare.com/client/v4/accounts/${input('jev-account')?.value.trim() ?? ''}/ai/run`
      if (auth) auth.value = 'bearer'
    }
    if (endpoint) endpoint.readOnly = cloudflare
    if (auth) auth.disabled = cloudflare || !connected || busy
    document.getElementById('jev-key-field')?.toggleAttribute('hidden', auth?.value === 'none')
    for (const field of document
      .getElementById('jev-settings-pane')
      ?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button') ??
      []) {
      if (field.id !== 'jev-auth')
        field.disabled = !connected || busy || (field.id === 'jev-transport' && laya)
      if (field.id === 'jev-save') field.disabled ||= !snapshot
    }
  }
  const status = (value: JevConfigSnapshot) => {
    snapshot = value
    text(
      'jev-source',
      value.source === 'environment'
        ? '环境变量正在覆盖此页面保存的配置；更改环境并重启后才会采用持久配置。'
        : `配置范围：当前 home / profile ${value.profile}。`,
    )
    text(
      'jev-state',
      value.effect === 'restart-required'
        ? '配置已保存；请手动重启后台后生效。'
        : value.configured
          ? '已保存配置，凭据不会回填。'
          : '尚未启用有效的决策服务配置。',
    )
  }
  const read = (): { settings: JevSettings; apiKey?: string } => {
    const backend = select('jev-backend')?.value === 'laya' ? 'laya' : 'jev'
    const transport =
      backend === 'jev' && select('jev-transport')?.value === 'cloudflare' ? 'cloudflare' : 'native'
    const authentication = select('jev-auth')?.value === 'none' && transport === 'native' ? 'none' : 'bearer'
    const credits = (id: string) => {
      const value = input(id)?.value.trim() ?? ''
      if (!value) return undefined
      const amount = Number(value)
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('请输入有限正数 credits，或留空表示未知。')
      return amount
    }
    const decision = credits('jev-decision-credits'),
      language = credits('jev-language-credits')
    const settings: JevSettings = {
      backend,
      transport,
      authentication,
      endpoint: input('jev-endpoint')?.value.trim() ?? '',
      model: input('jev-model')?.value.trim() ?? '',
      enabled: input('jev-enabled')?.checked ?? false,
      ...(transport === 'cloudflare' ? { accountId: input('jev-account')?.value.trim() ?? '' } : {}),
      ...(decision === undefined ? {} : { decisionRequestCredits: decision }),
      ...(language === undefined ? {} : { languageRequestCredits: language }),
    }
    const typed = input('jev-key')?.value ?? ''
    if (/^\s*bearer\s+/i.test(typed)) throw new Error('请只填写 token 本身，不要包含 “Bearer ” 前缀。')
    const key = authentication === 'bearer' ? typed || testedKey : undefined
    return { settings, ...(key ? { apiKey: key } : {}) }
  }
  const error = (value: unknown) => {
    const reason =
      value &&
      typeof value === 'object' &&
      'data' in value &&
      value.data &&
      typeof value.data === 'object' &&
      'reason' in value.data
        ? value.data.reason
        : undefined
    text(
      'jev-error',
      reason === 'CONFIG_REVISION_CONFLICT'
        ? '配置已被其他客户端修改，请重新读取后再试。'
        : reason === 'CONFIG_TEST_UNAUTHORIZED'
          ? '上游拒绝了该密钥（HTTP 401/403），请重新输入或更换 token 后再测试。'
          : reason === 'CONFIG_JEV_TRANSPORT_MISMATCH'
            ? 'Cloudflare 地址须选择 Cloudflare 传输类型；本地 Laya 仅支持原生 HTTP。'
            : reason === 'CONFIG_CREDENTIAL_REQUIRED'
              ? '请输入密钥；修改目标或认证后不能自动复用旧密钥。'
              : `${select('jev-backend')?.value === 'laya' ? '本地 Laya' : 'Jev'} 请求失败，请检查地址、模型、密钥和连接后重试。`,
    )
  }
  const refresh = async () => {
    if (!connected) {
      clearKey()
      text('jev-error', '后台未连接，请连接后重新读取配置。')
      render()
      return
    }
    const token = ++generation
    clearKey()
    busy = true
    render()
    text('jev-error', '')
    text('jev-state', '正在读取配置…')
    try {
      const value = await client.config.jevGet()
      if (token !== generation) return
      const settings = value.settings
      const assign = (id: string, value: string) => {
        const field = input(id) ?? select(id)
        if (field) field.value = value
      }
      activeBackend = settings?.backend ?? 'jev'
      drafts.clear()
      const savedBackends =
        value.backends ?? (settings ? [{ backend: settings.backend ?? 'jev', settings }] : [])
      for (const target of savedBackends) drafts.set(target.backend, savedDraft(target.settings))
      assign('jev-backend', activeBackend)
      assign('jev-transport', settings?.transport ?? 'native')
      assign('jev-account', settings?.accountId ?? '')
      assign('jev-endpoint', settings?.endpoint ?? '')
      assign('jev-model', settings?.model ?? 'jev-latest')
      assign('jev-auth', settings?.authentication ?? 'bearer')
      assign('jev-decision-credits', String(settings?.decisionRequestCredits ?? ''))
      assign('jev-language-credits', String(settings?.languageRequestCredits ?? ''))
      const enabled = input('jev-enabled')
      if (enabled) enabled.checked = settings?.enabled ?? true
      status(value)
    } catch (value) {
      if (token === generation) {
        text('jev-state', '配置读取失败。')
        error(value)
      }
    } finally {
      if (token === generation) {
        busy = false
        render()
      }
    }
  }
  const execute = async (save: boolean) => {
    if (busy || !connected || (save && !snapshot)) return
    const token = ++generation
    busy = true
    render()
    text('jev-error', '')
    text('jev-state', save ? '正在保存决策配置…' : '正在测试决策连接…')
    // Field validation is answered here: its message is about the form the user is looking at, and
    // it never carries upstream text, unlike anything returned from the request path below.
    let request: ReturnType<typeof read>
    try {
      request = read()
    } catch (value) {
      busy = false
      text('jev-state', '')
      text('jev-error', value instanceof Error ? value.message : '请输入有效的 Jev 配置。')
      render()
      return
    }
    try {
      if (save) {
        const value = await client.config.jevSave({ ...request, expectedRevision: snapshot?.revision ?? 0 })
        if (token !== generation) return
        status(value)
        try {
          await onSaved?.()
        } catch {
          if (token === generation)
            text('jev-error', '配置已保存，但运行方式列表刷新失败，请重新连接后检查。')
        }
      } else {
        const result = await client.config.jevTest(request)
        if (token !== generation) return
        testedKey = request.apiKey
        text(
          'jev-state',
          result.verified
            ? `评分测试通过（${result.model ?? request.settings.model}）；尚未保存。`
            : '评分测试未通过。',
        )
      }
    } catch (value) {
      if (token === generation) {
        text('jev-state', save ? '保存未完成。' : '测试未通过。')
        error(value)
      }
    } finally {
      if (token === generation) {
        const key = input('jev-key')
        if (key) key.value = ''
        if (save) testedKey = undefined
        busy = false
        render()
      }
    }
  }
  const close = () => {
    generation++
    busy = false
    clearKey()
    render()
  }
  shell?.addEventListener('input', (event) => {
    const target = event.target as HTMLElement | null
    if (!target?.id.startsWith('jev-')) return
    testedKey = undefined
    generation++
    text('jev-state', '配置已变更；此前测试结果已失效。')
    if (target.id !== 'jev-backend') render()
  })
  shell?.addEventListener('change', (event) => {
    const target = event.target as HTMLElement | null
    if (!target?.id.startsWith('jev-')) return
    testedKey = undefined
    generation++
    if (target.id === 'jev-backend') {
      drafts.set(activeBackend, {
        values: targetFields.map((id) => (input(id) ?? select(id))?.value ?? ''),
        enabled: input('jev-enabled')?.checked ?? true,
      })
      activeBackend = select('jev-backend')?.value === 'laya' ? 'laya' : 'jev'
      const draft = drafts.get(activeBackend) ?? {
        values:
          activeBackend === 'laya'
            ? ['native', '', 'http://127.0.0.1:8791/v1/systemone', 'multilingual', 'none', '', '']
            : ['native', '', '', 'jev-latest', 'bearer', '', ''],
        enabled: true,
      }
      targetFields.forEach((id, index) => {
        const field = input(id) ?? select(id)
        if (field) field.value = draft.values[index] ?? ''
      })
      const enabled = input('jev-enabled')
      if (enabled) enabled.checked = draft.enabled
      clearKey()
      text('jev-state', '决策后端已变更；此前测试结果已失效，原目标草稿保留至重新读取。')
    }
    if (target.id === 'jev-transport') {
      const model = input('jev-model')
      if (model) model.value = select('jev-transport')?.value === 'cloudflare' ? 'typesafe/jev' : 'jev-latest'
      if (select('jev-transport')?.value === 'native') {
        const endpoint = input('jev-endpoint')
        try {
          const url = new URL(endpoint?.value ?? '')
          if (
            endpoint &&
            url.hostname === 'api.cloudflare.com' &&
            /^\/client\/v4\/accounts\/[^/]+\/ai\/run$/.test(url.pathname)
          )
            endpoint.value = ''
        } catch {
          /* The backend validates a manually entered native target. */
        }
      }
      clearKey()
    }
    render()
  })
  shell?.addEventListener('click', (event) => {
    const id = (event.target as HTMLElement | null)?.closest('button')?.id
    if (id === 'jev-test') void execute(false)
    if (id === 'jev-save') void execute(true)
    if (id === 'jev-refresh') void refresh()
    if (id === 'config-close' || (id && !id.startsWith('jev-') && id.endsWith('settings'))) close()
  })
  shell?.addEventListener('close', close)
  shell?.addEventListener('cancel', close)
  return {
    refresh,
    setConnected(value: boolean) {
      connected = value
      if (!value) {
        generation++
        busy = false
        clearKey()
      }
      render()
    },
  }
}
