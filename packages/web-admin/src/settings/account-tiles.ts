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

/** Split the backend's providers into the popular ones, in their fixed order, and the remainder. */
export function groupProviders<T extends { id: string }>(
  providers: readonly T[],
): { popular: T[]; more: T[] } {
  const popular = POPULAR_PROVIDERS.flatMap((id) => providers.filter((provider) => provider.id === id))
  const more = providers.filter((provider) => !popular.includes(provider))
  return more.length < FOLD_REMAINDER_FROM ? { popular: [...popular, ...more], more: [] } : { popular, more }
}

/**
 * The first step of adding an account: a tile per popular provider (Agnes AI first), each saying
 * how it connects, then a custom OpenAI-compatible address; every other provider the backend
 * offers sits in a fold below.
 */
export function providerTiles(
  providers: readonly Provider[],
  tr: (key: string) => string,
  select: (id: string, custom?: boolean) => void,
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
  const { popular, more } = groupProviders(providers)
  return createElement(
    'div',
    { className: 'account-provider-groups' },
    createElement(
      'div',
      { className: 'account-provider-choices' },
      ...popular.map(providerTile),
      ...(providers.some((provider) => provider.id === 'openai')
        ? [tile('custom', tr('accounts.custom'), tr('accounts.customHint'), () => select('openai', true))]
        : []),
    ),
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
