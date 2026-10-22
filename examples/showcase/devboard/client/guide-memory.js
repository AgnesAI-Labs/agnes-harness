// What the demo guide remembers in this browser (never the board): ticked steps, which roles have seen the
// guide and whether it may open by itself. Main-line ticks are shared by all roles, the rest is per role.
// localStorage can be blocked (private window, site data off): then everything lives in memory for the tab.

const MAIN_KEY = 'devboard.guide.main'
const AUTO_KEY = 'devboard.guide.autoOpen'
const roleKey = (role) => `devboard.guide.role.${role}`

/** `getStorage` returns a Storage; it may throw or return nothing. */
export function createGuideMemory(getStorage) {
  const fallback = new Map()
  const read = (key, empty) => {
    try {
      const raw = getStorage()?.getItem(key)
      if (raw) return JSON.parse(raw)
    } catch {}
    return fallback.get(key) ?? empty
  }
  const write = (key, value) => {
    fallback.set(key, value)
    try {
      getStorage()?.setItem(key, JSON.stringify(value))
    } catch {}
  }
  const roleState = (role) => read(roleKey(role), { done: [], seen: false })
  return {
    /** Ids of the manually ticked steps: of the main line, or of one role. */
    ticks: (main, role) => new Set(main ? read(MAIN_KEY, []) : roleState(role).done),
    setTick(main, role, id, on) {
      const ids = new Set(main ? read(MAIN_KEY, []) : roleState(role).done)
      if (on) ids.add(id)
      else ids.delete(id)
      if (main) write(MAIN_KEY, [...ids])
      else write(roleKey(role), { ...roleState(role), done: [...ids] })
    },
    seen: (role) => roleState(role).seen === true,
    markSeen: (role) => write(roleKey(role), { ...roleState(role), seen: true }),
    autoOpenOff: () => read(AUTO_KEY, false) === true,
    setAutoOpenOff: (off) => write(AUTO_KEY, off === true),
    /** The first visit of a role opens the guide by itself, unless the switch says otherwise. */
    shouldAutoOpen(role) {
      return !roleState(role).seen && read(AUTO_KEY, false) !== true
    },
    /** "从头开始": forget every tick of the main line and of this role. The role counts as seen. */
    restart(role) {
      write(MAIN_KEY, [])
      write(roleKey(role), { done: [], seen: true })
    },
  }
}

export const guideMemory = createGuideMemory(() => window.localStorage)
