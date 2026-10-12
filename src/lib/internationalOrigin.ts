export const INTERNATIONAL_APP_ORIGIN = 'https://app.lanwealth.com'

export function normalizeInternationalBase(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    if (host === 'bayze.cn' || host.endsWith('.bayze.cn')) return null
    return url.origin
  } catch {
    return null
  }
}
