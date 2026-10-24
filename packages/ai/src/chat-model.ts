/**
 * Known Agnes generation IDs are never conversation models, including relay-qualified IDs.
 * Unknown IDs remain usable for custom chat deployments; image input does not imply image output.
 */
export function isChatModelId(id: string): boolean {
  return !/(?:^|[/:])agnes-(?:image|video)(?:[-.]|$)/i.test(id)
}
