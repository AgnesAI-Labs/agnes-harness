// Adapted from dsh-superagent (MIT)
/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { SettingsVersion } from './app/store.js'
import type { SettingsSave } from './policy.js'

/** What a stop of the runtime left paused, and why. */
export interface Paused {
  at: string
  reason: 'disable' | 'generation' | 'shutdown'
  assignments: { ticketId: string; assignmentId: string }[]
  /** How the stop went: how long cancelling and killing took, of how many sessions, and those it could not quiet. */
  stop?: { ms: number; sessions: number; unstopped: string[] }
}

/** Prompt configuration as stored: the team's three sections, skill texts, and overrides of built-in parts by key. */
export interface PromptConfig {
  communication: string
  scope: string
  delivery: string
  skills: Record<string, string>
  overrides?: Record<string, { text: string; base?: string | undefined }> | undefined
}
/** A saved prompt configuration revision. */
export interface PromptVersion {
  revision: number
  previousRevision: number | null
  savedAt: string
  source: string
  config: PromptConfig
  /** Original unmigrated config preserved when differences cannot be compared across schema versions. */
  legacy?: { config: unknown }
}
/** A GitHub read that failed and is retried until its window ends. */
export interface Retry {
  since: string
  pr: boolean
  failedAt?: string
  attempts?: number
}

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(
  prefix: string,
  format = (...name: A) => name.join(':'),
): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: {
    revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:'),
  },
  /** Prompts: current revision and saved prompt versions. */
  prompts: {
    revision: record<number>('prompt-revision'),
    version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:'),
  },
  /**
   * Runtime: the main Session's ID, and the Assignments a stop left paused (their Sessions' turns cancelled and pending
   * Inputs dropped), which the next start reconciles.
   */
  runtime: { masterId: record<string>('master-id'), paused: record<Paused>('runtime-paused') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: {
    since: record<string>('github-since'),
    retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>(
      'github-stream:',
    ),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:'),
  },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: {
    chats: record<Record<string, boolean>>('feishu-chats'),
    history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'),
    initialized: family<boolean, [thread: string]>('thread-initialized:'),
  },
}
