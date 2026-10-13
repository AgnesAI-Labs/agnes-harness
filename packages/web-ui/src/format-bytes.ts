/** A byte count as mebibytes with one decimal, the way attachment sizes are shown ("3.0 MiB"). */
export const formatMegabytes = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MiB`
