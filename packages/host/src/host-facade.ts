import type { Host } from './host.js'

const sources = new WeakMap<Host, () => Host>()

/** Only Host-created facades may expose their owning object to descriptor-based inspection. */
export function hostInspectionSource(host: Host): Host {
  const seen = new Set<Host>()
  while (sources.has(host) && !seen.has(host)) {
    seen.add(host)
    host = sources.get(host)!()
  }
  return host
}

/** Overrides own their properties, including replacements by embedders and instrumentation. */
export function createHostFacade(base: Host, overrides: Partial<Host>, current = () => base): Host {
  const facade = new Proxy(base, {
    get(_target, property) {
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property)
      const target = current(),
        value = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            const target = current()
            return Reflect.apply(Reflect.get(target, property, target), target, args)
          }
        : value
    },
    set(target, property, value) {
      return Object.hasOwn(overrides, property)
        ? Reflect.set(overrides, property, value)
        : Reflect.set(target, property, value, target)
    },
    defineProperty(target, property, descriptor) {
      return Reflect.defineProperty(
        Object.hasOwn(overrides, property) ? overrides : target,
        property,
        descriptor,
      )
    },
    getOwnPropertyDescriptor(target, property) {
      return Reflect.getOwnPropertyDescriptor(
        Object.hasOwn(overrides, property) ? overrides : target,
        property,
      )
    },
  })
  sources.set(facade, current)
  return facade
}
