import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import type { UserSession }   from '../lib/supabase'
import { signOut }            from '../lib/supabase'
import { streamChat, MODELS } from '../lib/api'
import type { Message }       from '../lib/api'
import { g, T, LOCALES, SUGGESTIONS, PLACEHOLDER } from '../lib/i18n'
import type { Locale }        from '../lib/i18n'

type Conversation = { id: string; title: string; model: string; messages: Message[]; updatedAt: number }
const mkId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

// ── Store via Electron IPC or localStorage fallback ──────────────────────────
const store = {
  async get<T>(key: string): Promise<T | null> {
    const api = (window as any).electronAPI?.store
    if (api) return (await api.get(key)) as T ?? null
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
  },
  async set(key: string, val: unknown) {
    const api = (window as any).electronAPI?.store
    if (api) return api.set(key, val)
    localStorage.setItem(key, JSON.stringify(val))
  },
}

// ── Markdown renderer (inline) ───────────────────────────────────────────────
function CodeBlock({ lang, code, copyLabel, copiedLabel }: { lang:string; code:string; copyLabel:string; copiedLabel:string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ margin:'8px 0', borderRadius:6, overflow:'hidden', border:'1px solid var(--border2)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', background:'var(--bg4)', padding:'4px 12px', borderBottom:'1px solid var(--border)' }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--muted)' }}>{lang||'code'}</span>
        <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(()=>setCopied(false),2000) }}
          style={{ background:'none', border:'none', color:'var(--muted)', fontSize:11, cursor:'pointer', padding:'2px 6px', borderRadius:3 }}>
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre style={{ margin:0, padding:'10px 14px', background:'var(--bg3)', fontFamily:'var(--font-mono)', fontSize:12.5, lineHeight:1.6, overflowX:'auto' }} className="selectable">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderInline(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = []
  const rx = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`\n]+)`)/g
  let last=0,m: RegExpExecArray|null,i=0
  while ((m=rx.exec(text))!==null) {
    if(m.index>last) result.push(text.slice(last,m.index))
    if(m[2]) result.push(<strong key={i++}>{m[2]}</strong>)
    else if(m[3]) result.push(<em key={i++}>{m[3]}</em>)
    else if(m[4]) result.push(<code key={i++} style={{background:'var(--bg4)',border:'1px solid var(--border2)',borderRadius:3,padding:'1px 5px',fontFamily:'var(--font-mono)',fontSize:'.88em'}}>{m[4]}</code>)
    last=m.index+m[0].length
  }
  if(last<text.length) result.push(text.slice(last))
  return result
}

function renderContent(text: string, copyLabel: string, copiedLabel: string): React.ReactNode[] {
  if(!text) return []
  const parts: React.ReactNode[]=[]; const rx=/```(\w*)\n?([\s\S]*?)```/g; let last=0,m: RegExpExecArray|null,i=0
  while((m=rx.exec(text))!==null){
    const before=text.slice(last,m.index).trim()
    if(before) before.split(/\n{2,}/).forEach(p=>{if(p.trim()) parts.push(<p key={i++} style={{margin:'0 0 8px'}}>{renderInline(p.trim())}</p>)})
    parts.push(<CodeBlock key={i++} lang={m[1]} code={m[2].trimEnd()} copyLabel={copyLabel} copiedLabel={copiedLabel}/>)
    last=m.index+m[0].length
  }
  const after=text.slice(last).trim()
  if(after) after.split(/\n{2,}/).forEach(p=>{if(p.trim()) parts.push(<p key={i++} style={{margin:'0 0 8px'}}>{renderInline(p.trim())}</p>)})
  return parts
}

// ── Component ────────────────────────────────────────────────────────────────
interface Props { session: UserSession; onSignOut: () => void }

export default function ChatPage({ session, onSignOut }: Props) {
  const [locale,    setLocale]    = useState<Locale>('en')
  const [convs,     setConvs]     = useState<Conversation[]>([])
  const [activeId,  setActiveId]  = useState<string|null>(null)
  const [model,     setModel]     = useState('deepseek-v3')
  const [input,     setInput]     = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error,     setError]     = useState('')
  const [sidebar,   setSidebar]   = useState(true)
  const [showMenu,  setShowMenu]  = useState(false)
  const bottomRef   = useRef<HTMLDivElement>(null)
  const inputRef    = useRef<HTMLTextAreaElement>(null)
  const isMac = (window as any).electronAPI?.platform === 'darwin'
  const isWin = (window as any).electronAPI?.platform === 'win32'

  useEffect(() => {
    store.get<{ locale: Locale; convs: Conversation[]; model: string }>('chat_state').then(s => {
      if (s?.locale) setLocale(s.locale)
      if (s?.convs?.length) { setConvs(s.convs); setActiveId(s.convs[0].id); if(s.convs[0].model) setModel(s.convs[0].model) }
      if (s?.model) setModel(s.model)
    })
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }) }, [convs, activeId])

  async function persist(nextConvs: Conversation[]) {
    setConvs(nextConvs)
    await store.set('chat_state', { locale, convs: nextConvs.slice(0,60), model })
  }

  const activeConv = convs.find(c=>c.id===activeId)??null
  const messages   = activeConv?.messages??[]
  const curModel   = MODELS.find(m=>m.id===model)??MODELS[0]
  const copyLabel  = g(T.copy, locale)
  const copiedLabel= g(T.copied, locale)

  function newChat() {
    const c: Conversation={id:mkId(),title:g(T.newChat,locale),model,messages:[],updatedAt:Date.now()}
    persist([c,...convs]); setActiveId(c.id); setError('')
  }

  function switchConv(id:string) { setActiveId(id); const c=convs.find(c=>c.id===id); if(c) setModel(c.model); setError('') }

  function deleteConv(id:string,e:React.MouseEvent) {
    e.stopPropagation(); const next=convs.filter(c=>c.id!==id); persist(next)
    if(activeId===id) setActiveId(next[0]?.id??null)
  }

  async function sendMessage(text?: string) {
    const content=(text??input).trim(); if(!content||streaming) return
    setError(''); setInput(''); inputRef.current?.focus()
    const userMsg: Message={role:'user',content}
    const asstSlot: Message={role:'assistant',content:''}
    const existing=activeId?convs.find(c=>c.id===activeId):null
    let workId: string; let nextConvs: Conversation[]; let toSend: Message[]

    if(existing){
      workId=existing.id; toSend=[...existing.messages,userMsg]
      nextConvs=convs.map(c=>c.id===workId?{...c,model,updatedAt:Date.now(),title:c.messages.length===0?content.slice(0,42):c.title,messages:[...c.messages,userMsg,asstSlot]}:c)
    } else {
      const c: Conversation={id:mkId(),model,updatedAt:Date.now(),title:content.slice(0,42),messages:[userMsg,asstSlot]}
      workId=c.id; toSend=[userMsg]; nextConvs=[c,...convs]; setActiveId(c.id)
    }
    await persist(nextConvs); setStreaming(true)

    try {
      for await (const delta of streamChat(session.access_token, model, toSend)) {
        setConvs(prev=>{
          const r=prev.map(c=>c.id===workId?{...c,messages:c.messages.map((m,i)=>i===c.messages.length-1?{...m,content:m.content+delta}:m)}:c)
          store.set('chat_state',{locale,convs:r.slice(0,60),model}); return r
        })
      }
    } catch(err: unknown) {
      const msg=err instanceof Error?err.message:'Network error'; setError(msg)
      setConvs(prev=>{const r=prev.map(c=>c.id===workId?{...c,messages:c.messages.slice(0,-1)}:c); store.set('chat_state',{locale,convs:r.slice(0,60),model}); return r})
    } finally { setStreaming(false) }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}
  }
  function autoResize(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value); e.target.style.height='auto'; e.target.style.height=`${Math.min(e.target.scrollHeight,200)}px`
  }

  async function handleSignOut() { await signOut(); onSignOut() }

  // ── Layout ────────────────────────────────────────────────────────────────
  return (
    <div style={{display:'flex',flexDirection:'column',height:'100vh',background:'var(--bg)'}}>

      {/* Title bar (Windows: manual drag + controls) */}
      {isWin && (
        <div style={{height:32,background:'var(--bg2)',display:'flex',alignItems:'center',WebkitAppRegion:'drag' as any,flexShrink:0,borderBottom:'1px solid var(--border)',paddingLeft:12}}>
          <span style={{fontSize:12,color:'var(--muted)',flex:1}}>LanWealth AI</span>
          <div style={{display:'flex',WebkitAppRegion:'no-drag' as any}}>
            {[{icon:'—',action:'minimize'},{icon:'□',action:'maximize'},{icon:'✕',action:'close'}].map(b=>(
              <button key={b.action} onClick={()=>(window as any).electronAPI?.window[b.action]()}
                style={{width:46,height:32,background:'none',border:'none',color:'var(--muted)',fontSize:b.action==='close'?13:15,cursor:'pointer'}}
                onMouseEnter={e=>{(e.target as any).style.background=b.action==='close'?'#c42b1c':'var(--bg3)';(e.target as any).style.color='var(--text)'}}
                onMouseLeave={e=>{(e.target as any).style.background='none';(e.target as any).style.color='var(--muted)'}}>
                {b.icon}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Mac: spacer for traffic lights */}
      {isMac && <div style={{height:38,WebkitAppRegion:'drag' as any,flexShrink:0,background:'var(--bg2)',borderBottom:'1px solid var(--border)'}} />}

      {/* Body */}
      <div style={{display:'flex',flex:1,overflow:'hidden'}}>

        {/* Sidebar */}
        {sidebar && (
          <aside style={{width:220,background:'var(--bg2)',borderRight:'1px solid var(--border)',display:'flex',flexDirection:'column',flexShrink:0}}>
            <div style={{padding:12,borderBottom:'1px solid var(--border)'}}>
              <button onClick={newChat} style={{width:'100%',display:'flex',alignItems:'center',justifyContent:'center',gap:7,padding:'8px 12px',background:'var(--teal3)',border:'1px solid var(--teal2)',borderRadius:5,color:'var(--teal)',fontSize:13,cursor:'pointer'}}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6.5" y1="1" x2="6.5" y2="12"/><line x1="1" y1="6.5" x2="12" y2="6.5"/></svg>
                {g(T.newChat,locale)}
              </button>
            </div>
            <div style={{flex:1,overflowY:'auto',padding:'8px 6px',display:'flex',flexDirection:'column',gap:2}}>
              {convs.length===0
                ? <p style={{fontSize:12,color:'var(--dim)',textAlign:'center',padding:20}}>{g(T.noConvs,locale)}</p>
                : convs.map(c=>(
                    <div key={c.id} onClick={()=>switchConv(c.id)}
                      style={{display:'flex',alignItems:'center',gap:6,padding:'7px 10px',borderRadius:4,cursor:'pointer',background:c.id===activeId?'var(--bg4)':'transparent',border:`1px solid ${c.id===activeId?'var(--border2)':'transparent'}`}}
                      onMouseEnter={e=>{if(c.id!==activeId)(e.currentTarget as HTMLElement).style.background='var(--bg3)'}}
                      onMouseLeave={e=>{if(c.id!==activeId)(e.currentTarget as HTMLElement).style.background='transparent'}}>
                      <span style={{flex:1,fontSize:12.5,color:c.id===activeId?'var(--text)':'var(--muted)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{c.title}</span>
                      <button onClick={ev=>deleteConv(c.id,ev)} title={g(T.delete,locale)}
                        style={{opacity:0,background:'none',border:'none',color:'var(--dim)',fontSize:16,cursor:'pointer',lineHeight:1,padding:'0 2px'}}
                        onMouseEnter={e=>{(e.target as any).style.color='var(--text)'}}
                        onMouseLeave={e=>{(e.target as any).style.color='var(--dim)'}}
                        ref={el=>{if(el){const parent=el.parentElement!;parent.onmouseenter=()=>(el.style.opacity='1');parent.onmouseleave=()=>(el.style.opacity='0')}}}>×</button>
                    </div>
                  ))
              }
            </div>

            {/* Sidebar footer: user + settings */}
            <div style={{borderTop:'1px solid var(--border)',padding:12}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
                <div style={{width:24,height:24,borderRadius:'50%',background:'var(--bg4)',border:'1px solid var(--border2)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,color:'var(--muted)',fontFamily:'var(--font-mono)',flexShrink:0}}>
                  {session.email.slice(0,2).toUpperCase()}
                </div>
                <span style={{fontSize:11.5,color:'var(--muted)',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{session.email}</span>
                <button onClick={()=>setShowMenu(v=>!v)} style={{background:'none',border:'none',color:'var(--dim)',cursor:'pointer',fontSize:16,padding:'0 2px',lineHeight:1}}
                  onMouseEnter={e=>{(e.target as any).style.color='var(--text)'}} onMouseLeave={e=>{(e.target as any).style.color='var(--dim)'}}>⋯</button>
              </div>
              {showMenu && (
                <div style={{background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:5,overflow:'hidden'}}>
                  <div style={{padding:'4px 0'}}>
                    <div style={{padding:'4px 0',borderBottom:'1px solid var(--border)'}}>
                      <div style={{padding:'4px 12px',fontSize:11,color:'var(--dim)'}}>{g(T.settings,locale)}</div>
                      {LOCALES.map(l=>(
                        <button key={l.code} onClick={()=>{setLocale(l.code);setShowMenu(false)}}
                          style={{width:'100%',textAlign:'left',padding:'5px 12px',background:locale===l.code?'var(--bg4)':'none',border:'none',color:locale===l.code?'var(--teal)':'var(--muted)',fontSize:12,cursor:'pointer'}}>
                          {l.flag} {l.label}
                        </button>
                      ))}
                    </div>
                    <button onClick={handleSignOut}
                      style={{width:'100%',textAlign:'left',padding:'7px 12px',background:'none',border:'none',color:'var(--muted)',fontSize:12,cursor:'pointer'}}
                      onMouseEnter={e=>{(e.target as any).style.background='var(--bg4)'}} onMouseLeave={e=>{(e.target as any).style.background='none'}}>
                      {g(T.signout,locale)}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Main chat area */}
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minWidth:0}}>

          {/* Chat header */}
          <div style={{height:48,borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:10,padding:'0 14px',flexShrink:0,background:'var(--bg2)'}}>
            <button onClick={()=>setSidebar(v=>!v)} style={{background:'none',border:'none',color:'var(--muted)',cursor:'pointer',padding:5,borderRadius:4,display:'flex',alignItems:'center'}}
              onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='var(--bg3)'}} onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none'}}>
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5">
                <line x1="2" y1="4" x2="13" y2="4"/><line x1="2" y1="7.5" x2="13" y2="7.5"/><line x1="2" y1="11" x2="13" y2="11"/>
              </svg>
            </button>
            <select value={model} onChange={e=>{setModel(e.target.value);if(activeConv){const n=convs.map(c=>c.id===activeConv.id?{...c,model:e.target.value}:c);persist(n)}}}
              style={{flex:1,maxWidth:300,background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:5,color:'var(--text)',fontSize:13,padding:'5px 10px',cursor:'pointer',outline:'none'}}>
              {['DeepSeek','Google','Claude','OpenAI'].map(grp=>(
                <optgroup key={grp} label={`── ${grp} ──`}>
                  {MODELS.filter(m=>m.group===grp).map(m=><option key={m.id} value={m.id}>{m.name}  ({m.tag} · {m.price})</option>)}
                </optgroup>
              ))}
            </select>
            {messages.length>0 && (
              <button onClick={()=>{if(activeConv){const n=convs.map(c=>c.id===activeConv.id?{...c,messages:[]}:c);persist(n)}}}
                style={{background:'none',border:'1px solid var(--border)',borderRadius:4,color:'var(--muted)',fontSize:12,padding:'4px 10px',cursor:'pointer'}}
                onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='var(--bg3)'}} onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none'}}>
                {g(T.clear,locale)}
              </button>
            )}
          </div>

          {/* Messages */}
          <div style={{flex:1,overflowY:'auto',padding:'24px 20px',display:'flex',flexDirection:'column',gap:20}} className="selectable">
            {messages.length===0 ? (
              <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:10,margin:'auto',padding:'40px 20px',textAlign:'center',maxWidth:520,width:'100%'}}>
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="19" stroke="var(--teal2)" strokeWidth="1.5"/>
                  <circle cx="20" cy="20" r="12" stroke="var(--teal)" strokeWidth="1" opacity=".3"/>
                  <circle cx="20" cy="20" r="5" fill="var(--teal)" opacity=".7"/>
                </svg>
                <h2 style={{fontSize:22,fontWeight:600,color:'var(--text)',margin:0}}>{g(T.welcomeTitle,locale)}</h2>
                <p style={{fontSize:14,color:'var(--muted)',margin:0}}>{g(T.poweredBy,locale)} <strong style={{color:'var(--teal)'}}>{curModel.name}</strong></p>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:14,width:'100%'}}>
                  {SUGGESTIONS[locale].map(s=>(
                    <button key={s} onClick={()=>sendMessage(s)} style={{padding:'10px 14px',background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:6,color:'var(--muted)',fontSize:13,textAlign:'left',cursor:'pointer',lineHeight:1.4}}
                      onMouseEnter={e=>{const el=e.currentTarget;el.style.background='var(--bg4)';el.style.color='var(--text)';el.style.borderColor='var(--teal2)'}}
                      onMouseLeave={e=>{const el=e.currentTarget;el.style.background='var(--bg3)';el.style.color='var(--muted)';el.style.borderColor='var(--border2)'}}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : messages.map((msg,idx)=>(
              <div key={idx} style={{display:'flex',gap:12,maxWidth:780,width:'100%',alignSelf:msg.role==='user'?'flex-end':'flex-start',flexDirection:msg.role==='user'?'row-reverse':'row'}}>
                <div style={{width:28,height:28,borderRadius:'50%',border:'1px solid var(--border2)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontFamily:'var(--font-mono)',letterSpacing:.04,flexShrink:0,background:msg.role==='user'?'var(--teal3)':'var(--bg4)',color:msg.role==='user'?'var(--teal)':'var(--muted)',borderColor:msg.role==='user'?'var(--teal2)':'var(--border2)'}}>
                  {msg.role==='user' ? g(T.you,locale) : 'AI'}
                </div>
                <div style={{flex:1,fontSize:14,lineHeight:1.7,color:'var(--text)',minWidth:0,...(msg.role==='user'?{background:'var(--bg4)',border:'1px solid var(--border2)',borderRadius:'10px 2px 10px 10px',padding:'10px 14px',whiteSpace:'pre-wrap',wordBreak:'break-word'}:{padding:'2px 0'})}}>
                  {msg.role==='user'
                    ? msg.content
                    : msg.content ? renderContent(msg.content,copyLabel,copiedLabel) : <span style={{color:'var(--teal)',animation:'blink .7s steps(1) infinite'}}>▌</span>
                  }
                  {msg.role==='assistant'&&streaming&&idx===messages.length-1&&msg.content&&
                    <span style={{color:'var(--teal)',animation:'blink .7s steps(1) infinite'}}>▌</span>
                  }
                </div>
              </div>
            ))}
            {error && (
              <div style={{display:'flex',alignItems:'center',gap:8,padding:'10px 14px',background:'rgba(232,69,60,.08)',border:'1px solid rgba(232,69,60,.25)',borderRadius:6,color:'var(--red)',fontSize:13,maxWidth:640}}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="6"/><line x1="7" y1="4.5" x2="7" y2="7.5"/><circle cx="7" cy="10" r=".6" fill="currentColor" stroke="none"/></svg>
                <span>{error}</span>
                {(error.includes('credits')||error.includes('余额'))&&
                  <a href="https://app.lanwealth.com/dashboard/billing" target="_blank" rel="noreferrer" style={{marginLeft:'auto',color:'var(--teal)',fontWeight:500,whiteSpace:'nowrap'}}>{g(T.topup,locale)}</a>}
              </div>
            )}
            <div ref={bottomRef}/>
          </div>

          {/* Input */}
          <div style={{borderTop:'1px solid var(--border)',padding:'12px 16px 14px',flexShrink:0,background:'var(--bg2)'}}>
            <div style={{display:'flex',alignItems:'flex-end',gap:8,background:'var(--bg3)',border:'1px solid var(--border2)',borderRadius:10,padding:'8px 8px 8px 14px'}}>
              <textarea ref={inputRef} value={input} onChange={autoResize} onKeyDown={handleKeyDown}
                placeholder={PLACEHOLDER[locale].replace('{model}',curModel.name)}
                disabled={streaming} rows={1}
                style={{flex:1,background:'none',border:'none',outline:'none',color:'var(--text)',fontSize:14,lineHeight:1.55,resize:'none',fontFamily:'inherit',minHeight:24,maxHeight:200,overflowY:'auto',padding:'3px 0',opacity:streaming?.45:1}}/>
              <button onClick={()=>sendMessage()} disabled={!input.trim()||streaming} title={g(T.send,locale)}
                style={{width:34,height:34,borderRadius:7,background:'var(--teal)',border:'none',color:'#050505',display:'flex',alignItems:'center',justifyContent:'center',cursor:input.trim()&&!streaming?'pointer':'not-allowed',flexShrink:0,opacity:input.trim()&&!streaming?1:.3,transition:'opacity .15s'}}>
                {streaming
                  ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{animation:'rotate .8s linear infinite'}}><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" strokeDasharray="18 10"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="14" x2="8" y2="2"/><polyline points="4,6 8,2 12,6"/></svg>
                }
              </button>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes blink  { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes rotate { to{transform:rotate(360deg)} }
      `}</style>
    </div>
  )
}
