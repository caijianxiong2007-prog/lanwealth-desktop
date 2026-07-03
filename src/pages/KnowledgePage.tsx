import { useState, useEffect, useRef } from 'react'
import type { UserSession } from '../lib/supabase'
import type { Locale }      from '../lib/i18n'

// ── 桌面版知识库页 ────────────────────────────────────────────────────────────
// 与网页版共用同一套服务端 API(Bearer 鉴权):/api/extract → /api/knowledge →
// (cloud)/api/knowledge/source 或 (local)Electron IPC 本地留底。
// 桌面版独有:「仅本地」档 — 原件存本机 userData/knowledge-sources,索引在云端;
// 系统提取层升级后,可从本地原件一键重新入库(同名覆盖),无需翻找原文件。

const APP_URL = import.meta.env.APP_URL as string

const ACCEPT = '.pdf,.doc,.docx,.pptx,.xlsx,.xls,.csv,.tsv,.txt,.md,.json,.py,.js,.ts,.html,.css'
const MAX_DETAILS = 4

// 本页文案:zh 完整,其余语种回落 en(桌面版 SEA 语种用户极少,避免 i18n.ts 膨胀)
const L = {
  title:      { zh: '知识库',                     en: 'Knowledge base' },
  back:       { zh: '← 返回聊天',                 en: '← Back to chat' },
  intro:      { zh: '上传文档,Bayze 顾问回答时会自动检索并参考。支持 PDF/Word/PPT/表格/文本;扫描件自动 OCR。', en: 'Upload documents; the assistant retrieves them when answering. PDF/Word/PPT/spreadsheets/text; scans are OCRed.' },
  storeTo:    { zh: '存入:',                      en: 'Save to:' },
  personal:   { zh: '个人库(仅自己)',            en: 'Personal (only me)' },
  orgLib:     { zh: '企业库(全员共享)',          en: 'Org (shared)' },
  retention:  { zh: '原件留底:',                  en: 'Source retention:' },
  cloud:      { zh: '☁️ 云端(推荐)',             en: '☁️ Cloud (recommended)' },
  localOnly:  { zh: '💻 仅本地(本机留存)',        en: '💻 Local only (this device)' },
  none:       { zh: '🚫 不留底',                   en: '🚫 None' },
  retNote:    { zh: '说明:检索索引始终加密存储于云端;此选项仅决定原始文件留存位置。「仅本地」= 原件只存这台电脑,系统升级时在本机打开应用即可自动重建,换机或清除数据会丢失留底。', en: 'The searchable index always lives encrypted in the cloud. This only controls where the original file is kept. "Local only" keeps it on this device; open the app here after upgrades to rebuild.' },
  pick:       { zh: '＋ 点击选择文件上传',          en: '＋ Click to choose files' },
  uploading:  { zh: '上传中…',                     en: 'Uploading…' },
  docs:       { zh: '文档',                        en: 'Documents' },
  loading:    { zh: '加载中…',                     en: 'Loading…' },
  empty:      { zh: '还没有文档。点上方上传开始。',  en: 'No documents yet.' },
  orgBadge:   { zh: '企业',                        en: 'Org' },
  localBadge: { zh: '本地留底',                    en: 'Local source' },
  chunks:     { zh: '片段',                        en: 'chunks' },
  reingest:   { zh: '从本地原件重新入库',           en: 'Re-ingest from local source' },
  reingesting:{ zh: '重新入库中…',                  en: 'Re-ingesting…' },
  del:        { zh: '删除',                        en: 'Delete' },
  delConfirm: { zh: '删除这个文档及其索引?本地留底的原件也会一并清除。', en: 'Delete this document and its index? The locally retained source will also be removed.' },
  failed:     { zh: '失败',                        en: 'failed' },
  replaced:   { zh: '已覆盖更新同名旧版',           en: 'replaced previous version' },
  savedLocal: { zh: '原件已留存本机',               en: 'source kept on this device' },
  noText:     { zh: '无可提取文字',                 en: 'no extractable text' },
}
const t = (k: keyof typeof L, l: Locale) => (l === 'zh' ? L[k].zh : L[k].en)

type Doc = { id: string; name: string; chunks: number; created_at: string; scope?: 'personal' | 'org' }
type LocalSource = { docId: string; name: string }
type Retention = 'cloud' | 'local' | 'none'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const eapi = () => (window as any).electronAPI

interface Props { session: UserSession; onBack: () => void }

export default function KnowledgePage({ session, onBack }: Props) {
  const [locale, setLocale] = useState<Locale>('en')
  const [docs, setDocs] = useState<Doc[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [msg, setMsg] = useState('')
  const [inOrg, setInOrg] = useState(false)
  const [myRoles, setMyRoles] = useState<string[]>([])
  const [scope, setScope] = useState<'personal' | 'org'>('personal')
  const [retention, setRetention] = useState<Retention>('cloud')
  const [localSources, setLocalSources] = useState<Map<string, string>>(new Map())
  const [reingesting, setReingesting] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const isMac = eapi()?.platform === 'darwin'
  const hasLocalTier = Boolean(eapi()?.knowledge)
  const auth = { Authorization: `Bearer ${session.access_token}` }

  useEffect(() => {
    eapi()?.store?.get('chat_state').then((s: { locale?: Locale } | null) => { if (s?.locale) setLocale(s.locale) }).catch(() => undefined)
    load()
    refreshLocalSources()
    // 默认留底档跟个人设置(网页「设置」页可改);策略 local 而本机无 IPC(不应发生)则回落 cloud
    fetch(`${APP_URL}/api/user/prefs`, { headers: auth }).then(r => r.json()).then(j => {
      const v = String(j?.source_retention ?? 'cloud') as Retention
      if (['cloud', 'local', 'none'].includes(v)) setRetention(v === 'local' && !hasLocalTier ? 'cloud' : v)
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function load() {
    try {
      const r = await fetch(`${APP_URL}/api/knowledge`, { headers: auth, cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      setDocs(Array.isArray(j.docs) ? j.docs : [])
      setInOrg(Boolean(j.in_org))
      setMyRoles(Array.isArray(j.my_roles) ? j.my_roles : [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function refreshLocalSources() {
    try {
      const list: LocalSource[] = (await eapi()?.knowledge?.listSources()) ?? []
      setLocalSources(new Map(list.map(x => [x.docId, x.name])))
    } catch { /* ignore */ }
  }

  // 提取 → 入库 → 留底 三段式;file 可来自 <input> 或本地原件重建的 Blob
  async function ingestOne(file: File, opts: { retention: Retention }): Promise<{ ok: boolean; docId?: string; replaced?: boolean; detail?: string }> {
    const fd = new FormData()
    fd.set('file', file)
    fd.set('name', file.name)
    const ex = await fetch(`${APP_URL}/api/extract`, { method: 'POST', headers: auth, body: fd })
    const exj = await ex.json().catch(() => ({}))
    if (!ex.ok || !String(exj?.text ?? '').trim()) {
      return { ok: false, detail: String(exj?.error ?? t('noText', locale)) }
    }

    const body: Record<string, unknown> = { name: file.name, text: exj.text, table: exj.table, source_retention: opts.retention }
    if (inOrg && scope === 'org') { body.scope = 'org'; body.allowed_roles = myRoles }   // v1:归自己全部岗位(与网页默认一致)
    const kr = await fetch(`${APP_URL}/api/knowledge`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const kj = await kr.json().catch(() => ({}))
    if (!kr.ok || !kj?.docId) return { ok: false, detail: String(kj?.error ?? `HTTP ${kr.status}`) }

    // 层2留底
    if (kj.sourceRetention === 'cloud') {
      try {
        const sfd = new FormData()
        sfd.set('docId', String(kj.docId)); sfd.set('file', file); sfd.set('name', file.name)
        await fetch(`${APP_URL}/api/knowledge/source`, { method: 'POST', headers: auth, body: sfd })
      } catch { /* best-effort */ }
    } else if (opts.retention === 'local' && hasLocalTier) {
      try { await eapi().knowledge.saveSource(String(kj.docId), file.name, await file.arrayBuffer()) } catch { /* best-effort */ }
    }
    return { ok: true, docId: String(kj.docId), replaced: Boolean(kj.replaced) }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length || busy) return
    setBusy(true); setMsg('')
    let ok = 0, fail = 0
    const details: string[] = []
    const list = Array.from(files)
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      setProgress(`${i + 1}/${list.length} · ${f.name}`)
      try {
        const r = await ingestOne(f, { retention })
        if (r.ok) {
          ok++
          if (r.replaced && details.length < MAX_DETAILS) details.push(`${f.name}: ${t('replaced', locale)}`)
          if (retention === 'local' && details.length < MAX_DETAILS) details.push(`${f.name}: ${t('savedLocal', locale)}`)
        } else {
          fail++
          if (details.length < MAX_DETAILS) details.push(`${f.name}: ${r.detail ?? t('failed', locale)}`)
        }
      } catch (e) {
        fail++
        if (details.length < MAX_DETAILS) details.push(`${f.name}: ${e instanceof Error ? e.message : t('failed', locale)}`)
      }
    }
    if (fileRef.current) fileRef.current.value = ''
    setProgress('')
    setMsg(`✓ ${ok}${fail ? ` · ✗ ${fail}` : ''}${details.length ? ` — ${details.join('; ')}` : ''}`)
    setBusy(false)
    load(); refreshLocalSources()
  }

  // 「仅本地」档核心能力:提取层升级后,从本机原件重新走一遍 提取→入库(服务端同名覆盖)
  async function reingest(docId: string) {
    if (reingesting) return
    setReingesting(docId); setMsg('')
    try {
      const src = await eapi()?.knowledge?.readSource(docId)
      if (!src?.data) { setMsg(`✗ ${t('failed', locale)}: local source missing`); return }
      const bytes = src.data instanceof Uint8Array ? src.data : new Uint8Array(src.data)
      const file = new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], String(src.name ?? 'source.bin'))
      const r = await ingestOne(file, { retention: 'local' })
      if (r.ok && r.docId) {
        if (r.docId !== docId) await eapi()?.knowledge?.deleteSource(docId).catch(() => undefined)
        setMsg(`✓ ${src.name}: ${t('replaced', locale)}`)
      } else {
        setMsg(`✗ ${src.name}: ${r.detail ?? t('failed', locale)}`)
      }
    } finally {
      setReingesting(null)
      load(); refreshLocalSources()
    }
  }

  async function del(doc: Doc) {
    if (!window.confirm(t('delConfirm', locale))) return
    try {
      const r = await fetch(`${APP_URL}/api/knowledge?id=${encodeURIComponent(doc.id)}`, { method: 'DELETE', headers: auth })
      if (r.ok) {
        setDocs(d => d.filter(x => x.id !== doc.id))
        await eapi()?.knowledge?.deleteSource(doc.id).catch(() => undefined)
        refreshLocalSources()
      } else {
        const j = await r.json().catch(() => ({}))
        setMsg(`✗ ${t('del', locale)} ${t('failed', locale)}: ${j?.error ?? r.status}`)
      }
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  const chipStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    padding: '5px 13px', borderRadius: 6, fontSize: 12, fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: active ? 'var(--teal)' : 'var(--bg3)',
    border: `1px solid ${active ? 'var(--teal)' : 'var(--border2)'}`,
    color: active ? '#04130C' : disabled ? 'var(--dim)' : 'var(--muted)',
  })

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--text)' }}>
      {/* 顶栏(可拖拽;Mac 预留红绿灯位) */}
      <div style={{ height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg2)',
                    borderBottom: '1px solid var(--border)', padding: `0 14px 0 ${isMac ? 76 : 14}px`,
                    WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <button onClick={onBack}
          style={{ background: 'none', border: '1px solid var(--border2)', color: 'var(--muted)', fontSize: 12,
                   padding: '4px 10px', borderRadius: 5, cursor: 'pointer', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {t('back', locale)}
        </button>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{t('title', locale)}</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 14, maxWidth: 640 }}>{t('intro', locale)}</div>

        {inOrg && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('storeTo', locale)}</span>
            <button disabled={busy} onClick={() => setScope('personal')} style={chipStyle(scope === 'personal')}>{t('personal', locale)}</button>
            <button disabled={busy} onClick={() => setScope('org')} style={chipStyle(scope === 'org')}>{t('orgLib', locale)}</button>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('retention', locale)}</span>
          <button disabled={busy} onClick={() => setRetention('cloud')} style={chipStyle(retention === 'cloud')}>{t('cloud', locale)}</button>
          <button disabled={busy || !hasLocalTier} onClick={() => hasLocalTier && setRetention('local')} style={chipStyle(retention === 'local', !hasLocalTier)}>{t('localOnly', locale)}</button>
          <button disabled={busy} onClick={() => setRetention('none')} style={chipStyle(retention === 'none')}>{t('none', locale)}</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.6, marginBottom: 14, maxWidth: 640 }}>{t('retNote', locale)}</div>

        <button disabled={busy} onClick={() => fileRef.current?.click()}
          style={{ width: '100%', maxWidth: 640, padding: '26px 0', borderRadius: 10, fontSize: 13, cursor: busy ? 'default' : 'pointer',
                   background: 'var(--bg2)', border: '1px dashed var(--border2)', color: 'var(--muted)', marginBottom: 10 }}>
          {busy ? (progress || t('uploading', locale)) : t('pick', locale)}
        </button>
        <input ref={fileRef} type="file" accept={ACCEPT} multiple style={{ display: 'none' }} onChange={e => onFiles(e.target.files)} />

        {msg && <div style={{ fontSize: 12, color: msg.startsWith('✗') ? 'var(--red, #f87171)' : 'var(--teal)', marginBottom: 12, maxWidth: 640, lineHeight: 1.6 }}>{msg}</div>}

        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '16px 0 8px' }}>{t('docs', locale)}({docs.length})</div>
        {loading ? (
          <div style={{ fontSize: 12, color: 'var(--dim)' }}>{t('loading', locale)}</div>
        ) : docs.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dim)' }}>{t('empty', locale)}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 760 }}>
            {docs.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg2)',
                                       border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    📄 {d.name}
                    {d.scope === 'org' && <span style={{ marginLeft: 8, fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'var(--bg4)', color: 'var(--teal)' }}>{t('orgBadge', locale)}</span>}
                    {localSources.has(d.id) && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 7px', borderRadius: 4, background: 'var(--bg4)', color: 'var(--muted)' }}>💻 {t('localBadge', locale)}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
                    {d.chunks} {t('chunks', locale)} · {new Date(d.created_at).toLocaleDateString()}
                  </div>
                </div>
                {localSources.has(d.id) && (
                  <button disabled={busy || reingesting !== null} onClick={() => reingest(d.id)}
                    style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                             background: 'var(--bg3)', border: '1px solid var(--border2)', color: 'var(--muted)', flexShrink: 0 }}>
                    {reingesting === d.id ? t('reingesting', locale) : t('reingest', locale)}
                  </button>
                )}
                <button disabled={busy} onClick={() => del(d)}
                  style={{ fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                           background: 'none', border: '1px solid var(--border2)', color: 'var(--dim)', flexShrink: 0 }}>
                  {t('del', locale)}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
