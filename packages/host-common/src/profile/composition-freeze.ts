export function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') for (const child of Object.values(value)) freezeTree(child)
  return Object.freeze(value)
}
