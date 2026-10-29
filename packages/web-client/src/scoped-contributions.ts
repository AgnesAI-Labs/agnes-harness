import type { ClientContext } from './client-module.js'
import { ownContribution, scopedHomeEntries } from './contribution-scope.js'
import { getDshSlotDefinition } from './dsh-slot-catalog.js'
import { scopedExamplePages } from './example-pages.js'
import { factChainLinks, workbenchNavigation } from './fact-chain-links.js'
import { scopedPresentationRoles } from './presentation-roles.js'
import { scopedProfileStreams } from './profile-streams.js'
import type { SlotRegistry } from './registry.js'
import type { ModuleIdentity } from './service-contracts.js'
import {
  composerCommands,
  conversationCards,
  fileViewerActions,
  settingsSections,
  workbenchPanels,
} from './ui-registries.js'

/** A mount owns its registrations even when it fails before returning a disposer. */
export function contributionScope(effect: (off: () => void) => void) {
  let live = true
  const cleanups = new Set<() => void>()
  const stop = () => {
    if (!live) return
    live = false
    for (const off of [...cleanups].reverse()) {
      try {
        off()
      } catch {
        console.warn('[client-modules] scoped cleanup failed')
      }
    }
    cleanups.clear()
  }
  effect(stop)
  return {
    assert() {
      if (!live) throw new Error('Contribution scope is revoked')
    },
    effect(off: () => void) {
      if (live) cleanups.add(off)
      else off()
    },
    stop,
  }
}

/** Raw registries are host APIs. Author registrations always carry a synchronous owner revoke. */
export function bindContributions(
  ctx: ClientContext,
  module: ModuleIdentity,
  registry: SlotRegistry,
  bindSlots: (
    effect: (off: () => void) => void,
    assert: (name?: string, deferred?: boolean) => void,
  ) => SlotRegistry,
  registerCommand: ClientContext['commands']['register'],
  effect: (off: () => void) => void,
): void {
  const owner = module.binding?.owner ?? module.rowId ?? module.packageId
  const scope = contributionScope(effect)
  ownContribution(owner, scope.stop, effect)
  const assertGlobal = () => {
    scope.assert()
    const binding = ctx.availability.getSnapshot()
    if (binding?.lifetime !== 'profile' || binding.availability !== 'active')
      throw new Error('Global contributions require an active profile contribution')
  }
  const bind =
    <T extends unknown[]>(register: (...args: T) => () => void) =>
    (...args: T) => {
      assertGlobal()
      return ownContribution(owner, register(...args), scope.effect)
    }
  const expose = <T extends { register: (...args: never[]) => () => void }>(name: string, raw: T) =>
    Object.defineProperty(ctx, name, {
      value: Object.freeze({ register: bind(raw.register.bind(raw)) }),
      configurable: true,
    })
  expose('settingsSections', settingsSections)
  expose('conversationCards', conversationCards)
  expose('workbenchPanels', workbenchPanels)
  expose('fileViewerActions', fileViewerActions)
  expose('composerCommands', composerCommands)
  Object.defineProperty(ctx, 'factChainLinks', {
    value: { register: bind(factChainLinks.register.bind(factChainLinks)) },
    configurable: true,
  })
  Object.defineProperty(ctx, 'workbenchNavigation', {
    value: { register: bind(workbenchNavigation.register.bind(workbenchNavigation)) },
    configurable: true,
  })
  const locale = Object.create(ctx.locale) as ClientContext['locale']
  locale.register = bind(ctx.locale.register.bind(ctx.locale))
  Object.defineProperty(ctx, 'locale', { value: locale, configurable: true })
  const slots = bindSlots(scope.effect, (name, deferred) => {
    scope.assert()
    // A reviewed session slot can be awaited before its owning presentation mounts.
    // Registration itself still requires the live declaration in SlotRegistry.
    const slot = name
      ? (registry.spec(name) ?? (deferred ? getDshSlotDefinition(name) : undefined))
      : undefined
    if (
      (ctx.availability.getSnapshot()?.lifetime === 'session' ||
        ctx.availability.getSnapshot()?.availability === 'history-only') &&
      (!name || slot?.scope !== 'session')
    )
      throw new Error('Session contributions render recorded session data only')
  })
  Object.defineProperty(ctx, 'slots', { value: slots, configurable: true })
  const commands = ctx.commands
  Object.defineProperty(ctx, 'commands', {
    value: {
      ...commands,
      register: bind(registerCommand),
      execute(id: string, input: unknown) {
        assertGlobal()
        return commands.execute(id, input)
      },
    },
    configurable: true,
  })
  Object.defineProperty(ctx, 'homeEntries', {
    value: scopedHomeEntries(module, scope.effect),
    configurable: true,
  })
  Object.defineProperty(ctx, 'profile', {
    value: Object.freeze({
      ...ctx.profile,
      streams: scopedProfileStreams(module, ctx.availability, scope.effect),
    }),
    configurable: true,
  })
  Object.defineProperty(ctx, 'examplePages', {
    value: scopedExamplePages(module, scope.effect),
    configurable: true,
  })
  Object.defineProperty(ctx, 'presentationRoles', {
    value: scopedPresentationRoles(module, scope.effect, (provider) => ({
      ...provider,
      mount() {
        const child = Object.create(ctx) as ClientContext
        const childScope = contributionScope(scope.effect)
        Object.defineProperty(child, 'effect', {
          value: (...args: Parameters<ClientContext['effect']>) => {
            childScope.assert()
            const off = ctx.effect(...args)
            childScope.effect(() => {
              void off().catch(() => undefined)
            })
            return off
          },
          configurable: true,
        })
        bindContributions(child, module, registry, bindSlots, registerCommand, childScope.effect)
        try {
          const off = provider.mount(child)
          if (typeof off !== 'function') throw new Error('Presentation mount must return synchronous cleanup')
          childScope.effect(off)
          return childScope.stop
        } catch (error) {
          childScope.stop()
          throw error
        }
      },
    })),
    configurable: true,
  })
}
