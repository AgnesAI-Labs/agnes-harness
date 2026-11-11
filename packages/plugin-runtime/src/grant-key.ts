/**
 * The owner of a grant, a managed session record or a channel pairing: the package and one of its
 * plugin rows. Row ids are author-chosen, so a row alone would let a later package that declares the
 * same id inherit what the earlier one held. `#` separates the parts because a package id never
 * contains it, so `${packageId}#` prefixes only that package's keys; a row is `plugin/<hex>`, so a
 * record stored under a row alone matches no key. Not NUL: the storage adapter refuses NUL in a bound
 * TEXT parameter.
 */
export const grantKey = (packageId: string, owner: string) => `${packageId}#${owner}`
