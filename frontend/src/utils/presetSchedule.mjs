const ECUADOR_OFFSET_MS = -5 * 3600000

export function workingHours(at = Date.now()) {
  const ec = new Date(at + ECUADOR_OFFSET_MS)
  return ec.getUTCDay() >= 1 && ec.getUTCDay() <= 5 && ec.getUTCHours() >= 8 && ec.getUTCHours() < 18
}

export function nextEvening(at = Date.now()) {
  const ec = new Date(at + ECUADOR_OFFSET_MS)
  let target = Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), ec.getUTCDate(), 23)
  if (target <= at) target += 86400000
  return target
}

export function countdown(target, at = Date.now()) {
  const minutes = Math.max(0, Math.ceil((target - at) / 60000))
  return `Empieza en ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export const largeAnalysis = a => Boolean(a && (a.nuevos > 2000 || a.bytesNuevos > 20 * 1024 ** 3))
export const orderPresets = rows => [...rows].sort((a, b) => (a.lastAnalysis?.bytesNuevos ?? Infinity) - (b.lastAnalysis?.bytesNuevos ?? Infinity))
