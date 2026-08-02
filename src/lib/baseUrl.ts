// 多域名容灾:主域 TLS SNI 在大陆部分线路被 RST 阻断时,自动切换备用域。
// 候选 = 构建期常量(APP_URL + BACKUP_APP_URLS 逗号分隔,均由 electron.vite.config.ts define 注入);
// localStorage 记住上次可用域,下次启动优先用,避免每次冷启动都探测。

const CANDIDATES = [
  import.meta.env.APP_URL,
  ...(import.meta.env.BACKUP_APP_URLS || '').split(','),
].map(u => u?.trim().replace(/\/+$/, '')).filter(Boolean) as string[]

const LS_KEY = 'last_good_base'
const bad = new Set<string>()          // 本次会话内已确认网络层失败的域
let current: string | null = null
let resolving: Promise<string> | null = null

// 单域探测:/api/app-config(轻量+CDN 缓存;勿用 /api/health——服务端会外呼 Atlas/LiteLLM,重),
// 4 秒超时;收到任何 HTTP 响应即视为可达(被墙表现为 RST/超时)
async function probe(base: string): Promise<boolean> {
  try {
    await fetch(`${base}/api/app-config`, { cache: 'no-store', signal: AbortSignal.timeout(4000) })
    return true
  } catch { return false }
}

// 解析可用基址:优先上次可用域,其余按候选顺序探测,取首个可达;全挂时回落主域(让错误正常暴露)
export async function resolveBase(): Promise<string> {
  if (current && !bad.has(current)) return current
  if (resolving) return resolving
  resolving = (async () => {
    const last  = localStorage.getItem(LS_KEY)
    const order = last && CANDIDATES.includes(last)
      ? [last, ...CANDIDATES.filter(c => c !== last)]
      : [...CANDIDATES]
    for (const base of order) {
      if (bad.has(base)) continue
      if (await probe(base)) {
        current = base
        localStorage.setItem(LS_KEY, base)
        return base
      }
    }
    bad.clear()                        // 全挂:清黑名单回落主域,后续调用可重新探测
    current = null
    return CANDIDATES[0]
  })()
  try { return await resolving } finally { resolving = null }
}

// 标记坏域:网络层失败时调用,下次 resolveBase 换域
export function markBad(base: string) {
  bad.add(base)
  if (current === base) current = null
  if (localStorage.getItem(LS_KEY) === base) localStorage.removeItem(LS_KEY)
}

// 带容灾的 fetch:网络错误(fetch 抛异常,含被墙/断网/超时)时 markBad 并换域重试一次;
// HTTP 错误(4xx/5xx)说明链路是通的,不重试,由调用方自行处理。
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await resolveBase()
  try {
    return await fetch(`${base}${path}`, init)
  } catch (e) {
    markBad(base)
    const retry = await resolveBase()
    if (retry === base) throw e
    return fetch(`${retry}${path}`, init)
  }
}
