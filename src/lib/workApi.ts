// 国际版桌面端 · work 协议客户端(Phase 4,2026-10-31)
// 与 lanwealth-mobile-international/lib/workApi.ts 同契约的 Electron 版:
//   - REST 按 action 分发(ROUTES 表:method+path);
//   - Bearer 鉴权(令牌由宿主注入=Supabase session access_token);
//   - 基址走 apiFetch 多域名容灾(网络错误自动换域重试一次);
//   - 信封(protocolVersion=1 + requestId);401 抛错;业务失败返回 {__notOk}。
// Electron localStorage 持久化(无 RN AsyncStorage 依赖)。

export const WORK_PROTOCOL_VERSION = 1

export class WorkApiError extends Error {
  code: string
  status?: number
  newestSeq?: number
  constructor(code: string, message: string, status?: number, newestSeq?: number) {
    super(message)
    this.name = 'WorkApiError'
    this.code = code
    this.status = status
    this.newestSeq = newestSeq
  }
}

export function genId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  return (prefix || '') + rnd
}

export type WorkCallResult = { __notOk?: boolean; status?: number; code?: string; error?: string; requestId?: string } & Record<string, unknown>

export type WorkApiOptions = { getToken: () => string | Promise<string>; apiFetch: (path: string, init?: RequestInit) => Promise<Response> }

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'
type Route = { method: HttpMethod; path: (p: Record<string, unknown>) => string; needsThread?: boolean }

// 与 tokenbridge/mobile-international 的 ROUTES 同源
const ROUTES: Record<string, Route> = {
  work_thread_create:  { method: 'POST', path: () => '/api/work/threads' },
  work_thread_list:    { method: 'GET',  path: () => '/api/work/threads' },
  work_thread_update:  { method: 'PATCH',  path: (p) => `/api/work/threads/${enc(p.threadId)}`, needsThread: true },
  work_thread_delete:  { method: 'DELETE', path: (p) => `/api/work/threads/${enc(p.threadId)}`, needsThread: true },
  work_message_list:   { method: 'GET',  path: (p) => `/api/work/threads/${enc(p.threadId)}/messages`, needsThread: true },
  work_message_append: { method: 'POST', path: (p) => `/api/work/threads/${enc(p.threadId)}/messages`, needsThread: true },
  work_changes:        { method: 'GET',  path: () => '/api/work/changes' },
  work_tool_invoke:    { method: 'POST', path: () => '/api/work/invoke' },
  work_legacy_import:  { method: 'POST', path: () => '/api/work/legacy-import' },
  work_schedule_create: { method: 'POST', path: () => '/api/work/schedules' },
  work_schedule_list:   { method: 'GET',  path: () => '/api/work/schedules' },
  work_schedule_pause:  { method: 'PATCH', path: (p) => `/api/work/schedules/${enc(p.scheduleId)}` },
  work_schedule_resume: { method: 'PATCH', path: (p) => `/api/work/schedules/${enc(p.scheduleId)}` },
  work_schedule_run_now: { method: 'POST', path: (p) => `/api/work/schedules/${enc(p.scheduleId)}/run-now` },
  work_notifications_list: { method: 'GET',  path: () => '/api/work/notifications' },
  work_notifications_read: { method: 'POST', path: () => '/api/work/notifications' },
  work_confirmation_list:  { method: 'GET',  path: () => '/api/work/confirmations' },
  work_confirmation_confirm: { method: 'POST', path: (p) => `/api/work/confirmations/${enc(p.confirmationId)}/confirm` },
  work_commands_list: { method: 'GET',  path: () => '/api/work/commands' },
  knowledge_list: { method: 'GET',  path: () => '/api/knowledge' },
}

function enc(v: unknown): string {
  return encodeURIComponent(String(v ?? ''))
}

function toQuery(params: Record<string, unknown>, omit: string[]): string {
  const q: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (omit.includes(k) || v === undefined || v === null || v === '') continue
    q.push(`${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`)
  }
  return q.length ? '?' + q.join('&') : ''
}

export type WorkClient = {
  call: (action: string, params?: Record<string, unknown>) => Promise<WorkCallResult>
  pullChanges: (cursor: number, pageSize?: number) => Promise<{ changes: unknown[]; newestSeq: number }>
  threadCreate: (p: Record<string, unknown>) => Promise<WorkCallResult>
  threadList: (p: Record<string, unknown>) => Promise<WorkCallResult>
  threadUpdate: (p: Record<string, unknown>) => Promise<WorkCallResult>
  threadDelete: (p: Record<string, unknown>) => Promise<WorkCallResult>
  messageList: (p: Record<string, unknown>) => Promise<WorkCallResult>
  messageAppend: (p: Record<string, unknown>) => Promise<WorkCallResult>
  genId: (prefix: string) => string
}

export function createWorkApi(opts: WorkApiOptions): WorkClient {
  const getToken = opts.getToken

  async function send(method: HttpMethod, path: string, body: Record<string, unknown> | null): Promise<{ status: number; body: Record<string, unknown> }> {
    // apiFetch 已内置多域容灾(网络错误换域重试一次)
    const res = await opts.apiFetch(path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${await getToken()}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    let j: Record<string, unknown> | null = null
    try { j = await res.json() as Record<string, unknown> } catch { j = null }
    if (!j) throw new WorkApiError('BAD_RESPONSE', `响应不是 JSON(HTTP ${res.status})`, res.status)
    if (res.status === 401) throw new WorkApiError(String(j.code || 'UNAUTHENTICATED'), String(j.error || '未登录'), 401)
    return { status: res.status, body: j }
  }

  async function call(action: string, params?: Record<string, unknown>): Promise<WorkCallResult> {
    const route = ROUTES[action]
    if (!route) return { __notOk: true, status: 400, code: 'VALIDATION', error: `未知 action: ${action}` }
    const p: Record<string, unknown> = { ...(params || {}) }
    if (route.needsThread && !p.threadId) return { __notOk: true, status: 400, code: 'VALIDATION', error: `${action} 需要 threadId` }
    p.protocolVersion = WORK_PROTOCOL_VERSION
    p.requestId = p.requestId || genId('rq-')

    const path = route.path(p)
    let r: { status: number; body: Record<string, unknown> }
    if (route.method === 'GET') {
      r = await send('GET', path + toQuery(p, ['threadId', 'action']), null)
    } else {
      const { threadId: _o, ...rest } = p
      void _o
      r = await send(route.method, path, rest)
    }
    if (r.status >= 200 && r.status < 300) return r.body as WorkCallResult
    const out: WorkCallResult = { __notOk: true, status: r.status, code: r.body.code as string, error: r.body.error as string, requestId: r.body.requestId as string }
    if (r.body.newestSeq !== undefined) out.newestSeq = r.body.newestSeq
    return out
  }

  async function pullChanges(cursor: number, pageSize = 100): Promise<{ changes: unknown[]; newestSeq: number }> {
    const all: unknown[] = []
    let cur = cursor || 0
    for (let guard = 0; guard < 100; guard++) {
      const b = await call('work_changes', { cursor: cur, limit: pageSize })
      if (b.__notOk) {
        if (b.code === 'SYNC_EXPIRED') throw new WorkApiError('SYNC_EXPIRED', '变更流断档,需快照重建')
        throw new WorkApiError(b.code || 'CHANGES_FAILED', b.error || '拉取失败', b.status)
      }
      if (b.syncExpired) throw new WorkApiError('SYNC_EXPIRED', '变更流断档,需快照重建', undefined, Number(b.newestSeq) || undefined)
      all.push(...((b.changes as unknown[]) || []))
      if (!b.nextCursor) return { changes: all, newestSeq: Number(b.newestSeq) || 0 }
      cur = Number(b.nextCursor)
    }
    throw new WorkApiError('SYNC_LOOP', '变更流翻页超限')
  }

  const withId = (p: Record<string, unknown>, prefix: string) => {
    const q = { ...p }
    q.clientRequestId = q.clientRequestId || genId(prefix)
    return q
  }
  return {
    call,
    pullChanges,
    threadCreate: (p) => call('work_thread_create', withId(p, 'tc-')),
    threadList: (p) => call('work_thread_list', p),
    threadUpdate: (p) => call('work_thread_update', p),
    threadDelete: (p) => call('work_thread_delete', p),
    messageList: (p) => call('work_message_list', p),
    messageAppend: (p) => call('work_message_append', withId(p, 'ma-')),
    genId,
  }
}

// ── 本地缓存(Electron localStorage 版 workStore,最小面) ──
export type WorkThread = { threadId: string; scope: 'personal' | 'enterprise'; tenantId: string | null; title: string; revision: number; updatedAt?: number }
export type WorkMessage = { messageId: string; threadId: string; seq: number; role: string; parts: Array<{ t: string; v?: string; id?: string }> }
export type PendingSend = { clientRequestId: string; threadId: string; parts: WorkMessage['parts']; expectedRevision: number; queuedAt: number }

const SCHEMA = 'tb-desk-work-v1'

function baseKey(userId: string, scope: 'personal' | 'enterprise', orgId: string | null): string {
  const space = scope + (orgId == null || orgId === '' ? '' : ':' + orgId)
  return `${SCHEMA}:${userId}:${space}`
}

export function createDeskStore(userId: string, scope: 'personal' | 'enterprise', orgId: string | null) {
  const K = baseKey(userId, scope, orgId)
  const read = <T,>(key: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(K + ':' + key)
      return raw == null ? fallback : (JSON.parse(raw) as T)
    } catch { return fallback }
  }
  const write = (key: string, val: unknown): void => {
    if (!userId) return
    try { localStorage.setItem(K + ':' + key, JSON.stringify(val)) } catch { /* 配额满静默 */ }
  }
  return {
    listThreads: () => read<Array<{ byId: Record<string, WorkThread>; order: string[] }>>('threads', { byId: {}, order: [] }),
    saveThreads: (items: WorkThread[]) => {
      const byId: Record<string, WorkThread> = {}
      const order: string[] = []
      for (const t of items) { byId[t.threadId] = t; order.push(t.threadId) }
      write('threads', { byId, order })
    },
    getThread: (id: string) => read<{ byId: Record<string, WorkThread> }>('threads', { byId: {} }).byId[id] || null,
    upsertThread: (th: WorkThread) => {
      const t = read<{ byId: Record<string, WorkThread>; order: string[] }>('threads', { byId: {}, order: [] })
      if (!t.byId[th.threadId]) t.order.unshift(th.threadId)
      t.byId[th.threadId] = th
      write('threads', t)
    },
    getMessages: (id: string) => read<WorkMessage[] | null>('msg:' + id, null),
    setMessages: (id: string, items: WorkMessage[]) => write('msg:' + id, items),
    getCursor: () => read<number>('cursor', 0) || 0,
    setCursor: (seq: number) => write('cursor', seq),
    getPending: () => read<PendingSend[]>('pending', []),
    setPending: (list: PendingSend[]) => write('pending', list),
  }
}
