import { Button, Disclosure } from '@agnes/web-ui'
import { createElement, type ReactElement } from 'react'

type Provider = Readonly<{ id: string; label: string; authMethods?: readonly string[] }>

/**
 * The providers most people connect, in the order they are offered. Agnes AI is always first; the
 * rest of what the backend offers follows under "More providers".
 */
const POPULAR_PROVIDERS = [
  'agnes-ai',
  'deepseek',
  'openai',
  'anthropic',
  'google',
  'qwen',
  'moonshot',
  'zai',
] as const
/** A short remainder is listed with the others; a fold is only worth it for a long one. */
const FOLD_REMAINDER_FROM = 4
/** Any OpenAI chat-completions server at an address the person gives; it has a tile of its own. */
export const COMPATIBLE_PROVIDER = 'openai-compatible'
/** Backend providers that are relays, offered beside the relay presets. */
const RELAY_PROVIDERS = ['openrouter'] as const

/**
 * Agnes AI runs a China gateway (the provider's default address) and an international one. Keys are
 * issued per gateway, so the international choice is the same provider with its own address filled in.
 */
const AGNES_INTERNATIONAL_BASE_URL = 'https://apihub.agnes-ai.com/v1'

/** A relay is not a provider of its own: it fills the compatible form's address and account name. */
export type RelayPreset = Readonly<{ label: string; baseUrl: string }>
const RELAY_PRESETS = [
  ['siliconflow', 'https://api.siliconflow.cn/v1'],
  ['302ai', 'https://api.302.ai/v1'],
  ['aihubmix', 'https://aihubmix.com/v1'],
  ['volcengine-ark', 'https://ark.cn-beijing.volces.com/api/v3'],
  ['dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
] as const

/** Split the backend's providers into the popular ones, in their fixed order, the relays and the rest. */
export function groupProviders<T extends { id: string }>(
  providers: readonly T[],
): { popular: T[]; relay: T[]; more: T[] } {
  const popular = POPULAR_PROVIDERS.flatMap((id) => providers.filter((provider) => provider.id === id))
  const relay = RELAY_PROVIDERS.flatMap((id) => providers.filter((provider) => provider.id === id))
  const more = providers.filter(
    (provider) =>
      !popular.includes(provider) && !relay.includes(provider) && provider.id !== COMPATIBLE_PROVIDER,
  )
  return more.length < FOLD_REMAINDER_FROM
    ? { popular: [...popular, ...more], relay, more: [] }
    : { popular, relay, more }
}

/**
 * The first step of adding an account: a tile per popular provider (Agnes AI first), each saying
 * how it connects, then any OpenAI-compatible address; a row of relays; every other provider the
 * backend offers sits in a fold below.
 */
export function providerTiles(
  providers: readonly Provider[],
  tr: (key: string) => string,
  select: (id: string, preset?: RelayPreset) => void,
  quick = false,
): ReactElement {
  const tile = (key: string, name: string, hint: string, onClick: () => void) =>
    createElement(
      Button,
      { key, htmlType: 'button', onClick, 'data-provider': key },
      createElement('strong', {}, name),
      createElement('small', {}, hint),
    )
  const providerTile = (provider: Provider) =>
    tile(
      provider.id,
      provider.label,
      tr(
        provider.id === 'agnes-ai'
          ? 'accounts.recommended'
          : (provider.authMethods ?? []).includes('oauth')
            ? 'accounts.keyOrLoginHint'
            : 'accounts.keyApiHint',
      ),
      () => select(provider.id),
    )
  const agnesInternational = () => {
    const preset = { label: tr('accounts.agnesInternational'), baseUrl: AGNES_INTERNATIONAL_BASE_URL }
    return tile('agnes-ai:international', preset.label, tr('accounts.agnesInternationalHint'), () =>
      select('agnes-ai', preset),
    )
  }
  const { popular, relay, more } = groupProviders(providers)
  const compatible = !quick && providers.some((provider) => provider.id === COMPATIBLE_PROVIDER)
  const presets = compatible
    ? RELAY_PRESETS.map(([id, baseUrl]) => {
        const preset = { label: tr(`accounts.preset.${id}`), baseUrl }
        return tile(`preset:${id}`, preset.label, tr('accounts.relayHint'), () =>
          select(COMPATIBLE_PROVIDER, preset),
        )
      })
    : []
  return createElement(
    'div',
    { className: 'account-provider-groups' },
    createElement(
      'div',
      { className: 'account-provider-choices' },
      ...(quick ? popular.slice(0, 4) : popular).flatMap((provider) =>
        provider.id === 'agnes-ai' && !quick
          ? [providerTile(provider), agnesInternational()]
          : [providerTile(provider)],
      ),
      ...(quick ? [tile('more', tr('accounts.moreProviders'), '…', () => select(''))] : []),
      ...(compatible
        ? [
            tile(COMPATIBLE_PROVIDER, tr('accounts.custom'), tr('accounts.customHint'), () =>
              select(COMPATIBLE_PROVIDER),
            ),
          ]
        : []),
    ),
    !quick &&
      relay.length + presets.length > 0 &&
      createElement(
        'div',
        { className: 'account-provider-relays', 'data-testid': 'account-relays' },
        createElement('p', { className: 'account-provider-group-label' }, tr('accounts.relays')),
        createElement(
          'div',
          { className: 'account-provider-choices' },
          ...relay.map(providerTile),
          ...presets,
        ),
      ),
    !quick &&
      more.length > 0 &&
      createElement(
        Disclosure,
        {
          variant: 'plain',
          summary: tr('accounts.moreProviders'),
          meta: String(more.length),
          'data-testid': 'account-more-providers',
        },
        createElement('div', { className: 'account-provider-choices' }, ...more.map(providerTile)),
      ),
  )
}

/** Welcome shortcuts reuse the same catalog, ordering and selection as the account form. */
export function accountWelcome(
  providers: readonly Provider[],
  tr: (key: string) => string,
  begin: () => void,
  select: (id: string) => void,
  close: () => void,
) {
  return {
    providerChoices: providerTiles(
      providers,
      tr,
      (id) => {
        begin()
        if (id) select(id)
      },
      true,
    ),
    onDemo: () => {
      close()
      document.querySelector<HTMLButtonElement>('#new')?.click()
    },
  }
}

/** A new account is named after its provider; a second one of the same provider gets a number. */
export function defaultAccountLabel(base: string, taken: readonly string[]): string {
  for (let index = 1; base; index++) {
    const label = index === 1 ? base : `${base} ${index}`
    if (!taken.includes(label)) return label
  }
  return base
}

/**
 * Entering a key asks for it to be checked: run `test` once the input settles. A newer call, or
 * `cancel`, replaces the pending one, so a half-entered key is never sent.
 */
export function settledTest(test: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    cancel: () => clearTimeout(timer),
    schedule(delay: number) {
      clearTimeout(timer)
      timer = setTimeout(test, delay)
    },
  }
}

/**
 * A new account's dialog names the step on screen ("Add account", then "Connect <provider>") above
 * a two-step indicator; an account being edited keeps its own title and shows no steps.
 */
export function syncAccountHeading(
  title: HTMLElement | undefined,
  step: 'provider' | 'connection',
  editing: boolean,
  inline: boolean,
  provider: string,
  tr: (key: string, vars?: Record<string, string>) => string,
): void {
  const steps = document.getElementById('config-account-steps')
  if (steps) steps.hidden = editing || inline
  if (title && !editing)
    title.textContent =
      step === 'provider'
        ? tr('settings.account.addTitle')
        : tr('settings.account.connectTitle', { provider })
}
