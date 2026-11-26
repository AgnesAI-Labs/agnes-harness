const reservedAsset = /^\/(?:plugins|skins)(?:\/|$)/u

export function noncanonicalAssetPath(raw: string, normalized: string): boolean {
  return raw !== normalized && (reservedAsset.test(raw) || reservedAsset.test(normalized))
}
