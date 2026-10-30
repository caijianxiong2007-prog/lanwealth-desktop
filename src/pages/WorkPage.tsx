// 国际版桌面端 · 工作记录页(Phase 4,2026-10-31)
// 三标签布局(会话/指令库/知识库)+ 会话消息流 + 场景快捷条 + 空态引导。
// 数据层 = lib/workApi(桌面适配版);鉴权 = Supabase session Bearer。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UserSession } from '../lib/supabase'
import { apiFetch } from '../lib/baseUrl'
import { createWorkApi, createDeskStore, type WorkThread, type WorkMessage } from '../lib/workApi'

type SideTab = 'threads' | 'cmds' | 'kb'

type ScenarioItem = { id: string; title: string; icon: string; prompt?: string }

const SCENARIOS: ScenarioItem[] = [
  { id: 'sc-summary', title: 'Summary', icon: '📊', prompt: 'Help me generate a summary of business data' },
  { id: 'sc-weekly', title: 'Weekly Report', icon: '📝', prompt: 'Help me write a weekly work report' },
  { id: 'sc-search', title: 'Search', icon: '🔍', prompt: 'Help me find relevant knowledge' },
  { id: 'sc-customer', title: 'Customer', icon: '👥', prompt: 'Help me look up customer information' },
]

const PROMPTS = [
  { icon: '📊', text: 'Summarize this week\'s key business metrics and trends' },
  { icon: '👥', text: 'Show me the latest follow-up status for my top customers' },
  { icon: '📝', text: 'Draft a brief project status update for the team' },
]

const C = { bg: '#0d0f1c', card: '#171a2e', border: '#252845', text: '#e8eaf6', muted: '#80849e', teal: '#2dd4a7', tealDim: '#0a2e24', input: '#12142a' }

export default function WorkPage({ session, onBack }: { session: UserSession; onBack: () => void }) {
  const [threads, setThreads] = useState<WorkThread[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<WorkMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(1)
  const [sideTab, setSideTab] = useState<SideTab>('threads')
  const [kbItems, setKbItems] = useState<Array<{ id: string; name: string; meta: string }>>([])
  const ctxRef = useRef<{ api: ReturnType<typeof createWorkApi>; store: ReturnType<typeof createDeskStore> } | null>(null)
  const msgsEndRef = useRef<HTMLDivElement>(null)

  const ensureCtx = useCallback(() => {
    if (ctxRef.current) return ctxRef.current
    const api = createWorkApi({ getToken: async () => (await import('../lib/supabase')).getSession().then(s => s?.access_token ?? ''), apiFetch })
    const store = createDeskStore(session.id, 'personal', null)
    ctxRef.current = { api, store }
    return ctxRef.current
  }, [session.id])

  const refresh = useCallback(async () => {
    const ctx = ensureCtx()
    setBusy(true)
    try {
      const cached = ctx.store.listThreads()
      setThreads(cached.order.map(id => cached.byId[id]).filter(Boolean))
      const r = await ctx.api.threadList({ scope: 'personal', limit: 100 })
      if (!r.__notOk && Array.isArray(r.items)) {
        const items = r.items as WorkThread[]
        ctx.store.saveThreads(items)
        setThreads(items)
        setNotice('')
      }
    } catch (e) { setNotice(String((e as Error).message).slice(0, 60)) }
    finally { setBusy(false) }
  }, [ensureCtx])

  useEffect(() => { void refresh() }, [refresh])

  const openThread = useCallback(async (th: WorkThread) => {
    const ctx = ensureCtx()
    setSelected(th.threadId)
    const cached = ctx.store.getMessages(th.threadId)
    if (cached) setMessages(cached)
    const r = await ctx.api.messageList({ threadId: th.threadId, beforeSeq: 9007199254740991, limit: 200 })
    if (!r.__notOk && Array.isArray(r.items)) {
      setMessages(r.items as WorkMessage[])
      ctx.store.setMessages(th.threadId, r.items as WorkMessage[])
    }
    setRevision(th.revision)
    msgsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [ensureCtx])

  const createThread = useCallback(async () => {
    const ctx = ensureCtx()
    const title = prompt('Thread title (optional)', '') ?? ''
    setBusy(true)
    try {
      const r = await ctx.api.threadCreate({ scope: 'personal', title })
      if (r.__notOk) { setNotice('Create failed: ' + (r.error || r.code)); return }
      const th = r.thread as WorkThread
      ctx.store.upsertThread(th)
      await refresh()
      setSelected(th.threadId)
      setMessages([])
      setRevision(th.revision)
    } finally { setBusy(false) }
  }, [ensureCtx, refresh])

  const send = useCallback(async () => {
    const ctx = ensureCtx()
    if (!selected || !draft.trim()) return
    setBusy(true)
    try {
      const r = await ctx.api.messageAppend({ threadId: selected, parts: [{ t: 'text', v: draft.trim() }], expectedRevision: revision })
      setDraft('')
      if (r.__notOk) {
        if (r.code === 'REVISION_CONFLICT') { setNotice('Version conflict, reloading…'); return }
        setNotice('Send failed: ' + (r.error || r.code))
        return
      }
      if (typeof r.revision === 'number') setRevision(r.revision)
      const ml = await ctx.api.messageList({ threadId: selected, beforeSeq: 9007199254740991, limit: 200 })
      if (!ml.__notOk && Array.isArray(ml.items)) {
        setMessages(ml.items as WorkMessage[])
        ctx.store.setMessages(selected, ml.items as WorkMessage[])
      }
      setNotice('')
    } finally { setBusy(false) }
  }, [selected, draft, revision, ensureCtx])

  const loadKb = useCallback(async () => {
    try {
      const r = await apiFetch('/api/knowledge').then(res => res.json())
      const docs = Array.isArray(r.docs) ? r.docs : Array.isArray(r.items) ? r.items : []
      setKbItems(docs.slice(0, 50).map((d: { id: string; name?: string; title?: string; org_id?: string | null }) => ({
        id: d.id, name: d.name || d.title || '(untitled)', meta: d.org_id ? 'Org' : 'Personal',
      })))
    } catch { setKbItems([]) }
  }, [])

  useEffect(() => { if (sideTab === 'kb') void loadKb() }, [sideTab, loadKb])

  const fillPrompt = useCallback((text: string) => {
    setDraft(text)
    const el = document.querySelector<HTMLTextAreaElement>('#wk-input')
    if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length }
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, color: C.text, fontFamily: 'system-ui' }}>
      {/* 顶栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: C.teal, cursor: 'pointer', fontSize: 14 }}>‹ Back</button>
        <strong>Work Records</strong>
        <span style={{ flex: 1 }} />
        {notice && <span style={{ fontSize: 12, color: '#e05656' }}>{notice}</span>}
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 侧栏(三标签) */}
        <div style={{ width: 250, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', background: C.card }}>
          <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
            {([
              ['threads', '📋 Threads'],
              ['cmds', '🎯 Commands'],
              ['kb', '📚 Knowledge'],
            ] as Array<[SideTab, string]>).map(([key, label]) => (
              <div key={key}
                onClick={() => setSideTab(key)}
                style={{
                  flex: 1, padding: '8px 0', textAlign: 'center', cursor: 'pointer', fontSize: 12, userSelect: 'none',
                  color: sideTab === key ? C.teal : C.muted,
                  borderBottom: sideTab === key ? `2px solid ${C.teal}` : '2px solid transparent',
                  fontWeight: sideTab === key ? 600 : 400,
                }}>
                {label}
              </div>
            ))}
          </div>

          {sideTab === 'threads' && (
            <div style={{ overflowY: 'auto', flex: 1, padding: 8 }}>
              {threads.length === 0 ? (
                <div style={{ color: C.muted, textAlign: 'center', marginTop: 20, fontSize: 13 }}>(empty)</div>
              ) : threads.map((th) => (
                <div key={th.threadId}
                  onClick={() => openThread(th)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px',
                    borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                    background: selected === th.threadId ? C.tealDim : 'transparent',
                  }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontSize: 13 }}>{th.title || '(untitled)'}</span>
                  <small style={{ color: C.muted, marginLeft: 8 }}>r{th.revision}</small>
                </div>
              ))}
            </div>
          )}

          {sideTab === 'cmds' && (
            <div style={{ overflowY: 'auto', flex: 1, padding: 4 }}>
              {SCENARIOS.map((sc, i) => (
                <div key={i}
                  onClick={() => { fillPrompt(sc.prompt || ''); setSideTab('threads') }}
                  style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', margin: '6px 4px', cursor: 'pointer', background: C.bg }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
                    <span>{sc.icon}</span>{sc.title}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sc.prompt}</div>
                  <div style={{ marginTop: 5, fontSize: 10, color: C.teal }}>Fill in →</div>
                </div>
              ))}
            </div>
          )}

          {sideTab === 'kb' && (
            <div style={{ overflowY: 'auto', flex: 1, padding: 4 }}>
              {kbItems.length === 0 ? (
                <div style={{ color: C.muted, textAlign: 'center', marginTop: 20, fontSize: 13 }}>(no documents — upload in Knowledge page)</div>
              ) : kbItems.map((k) => (
                <div key={k.id}
                  onClick={() => { fillPrompt(`Please refer to 「${k.name}」 and answer: `); setSideTab('threads') }}
                  title="Click to reference"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 15 }}>📄</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.name}</div>
                    <div style={{ fontSize: 10, color: C.muted }}>{k.meta}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 主区 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
            {messages.length === 0 && selected ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 280, gap: 16 }}>
                <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>What can I help you with?</h2>
                <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>Type below or click a suggestion</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 420 }}>
                  {PROMPTS.map((p, i) => (
                    <div key={i}
                      onClick={() => fillPrompt(p.text)}
                      style={{ border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.teal}`, borderRadius: 8, padding: '10px 14px', cursor: 'pointer', background: C.card, fontSize: 13 }}>
                      <span style={{ marginRight: 8 }}>{p.icon}</span>{p.text}
                    </div>
                  ))}
                </div>
              </div>
            ) : messages.length === 0 && !selected ? (
              <div style={{ color: C.muted, textAlign: 'center', marginTop: 40 }}>Select a thread or create one</div>
            ) : messages.map((m) => (
              <div key={m.messageId}
                style={{
                  margin: '8px 0', padding: '8px 12px', borderRadius: 8, maxWidth: '78%',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: m.role === 'user' ? C.tealDim : C.card,
                  marginLeft: m.role === 'user' ? 'auto' : 0,
                }}>
                {m.role !== 'user' && <small style={{ color: C.muted, display: 'block', marginBottom: 2 }}>[{m.role === 'assistant' ? 'Bayze' : m.role}]</small>}
                {m.parts?.[0]?.v || ''}
              </div>
            ))}
            <div ref={msgsEndRef} />
          </div>

          {/* 场景快捷条 */}
          <div style={{ display: 'flex', gap: 6, padding: '6px 12px 0', overflowX: 'auto', borderTop: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
            {SCENARIOS.map((sc, i) => (
              <button key={i}
                onClick={() => fillPrompt(sc.prompt || '')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px solid ${C.border}`, borderRadius: 18,
                  padding: '4px 14px', cursor: 'pointer', background: C.card, color: C.text, fontSize: 13, whiteSpace: 'nowrap',
                }}>
                <span>{sc.icon}</span>{sc.title}
              </button>
            ))}
          </div>

          {/* 输入区 */}
          <div style={{ padding: 10, display: 'flex', gap: 8 }}>
            <textarea id="wk-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send() }}
              placeholder="Type a message (Ctrl+Enter to send)…"
              style={{ flex: 1, height: 64, resize: 'vertical', border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', background: C.input, color: C.text }}
            />
            <button onClick={send} disabled={busy || !selected}
              style={{ background: C.teal, color: '#0a2e24', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
