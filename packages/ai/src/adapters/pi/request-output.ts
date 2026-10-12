/** DeepSeek omits max_tokens at an 8K non-thinking default, regardless of catalog capacity.
 * https://api-docs.deepseek.com/api/create-chat-completion/ (verified 2026-10-12).
 * Keep the request default bounded; catalog capacity also prices child/compaction holds.
 */
export function deepSeekDefaultOutput(baseUrl: string, capacity: number): number | undefined {
  return /^https:\/\/api\.deepseek\.com(?:\/(?:v1|beta))?\/?$/.test(baseUrl)
    ? Math.min(32768, capacity)
    : undefined
}
