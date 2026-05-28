import { useState }          from 'react'
import { signIn }            from '../lib/supabase'
import type { UserSession }  from '../lib/supabase'
import { g, T, LOCALES }     from '../lib/i18n'
import type { Locale }       from '../lib/i18n'

interface Props { onSuccess: (s: UserSession) => void }

export default function LoginPage({ onSuccess }: Props) {
  const [locale,   setLocale]  = useState<Locale>('en')
  const [email,    setEmail]   = useState('')
  const [password, setPass]    = useState('')
  const [loading,  setLoading] = useState(false)
  const [error,    setError]   = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    const { data, error: err } = await signIn(email, password)
    setLoading(false)
    if (err) { setError(err.message); return }
    if (data.session) onSuccess({ id: data.user!.id, email: data.user!.email!, access_token: data.session.access_token })
  }

  const isMac = (window as any).electronAPI?.platform === 'darwin'

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'var(--bg)' }}>
      {/* Title bar drag region */}
      <div style={{ height: isMac ? 38 : 0, WebkitAppRegion: 'drag' as any, flexShrink:0 }} />

      {/* Language picker */}
      <div style={{ display:'flex', justifyContent:'flex-end', padding:'8px 20px' }}>
        <select value={locale} onChange={e => setLocale(e.target.value as Locale)}
          style={{ background:'var(--bg3)', border:'1px solid var(--border2)', borderRadius:4, color:'var(--muted)', fontSize:12, padding:'3px 8px', cursor:'pointer' }}>
          {LOCALES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
        </select>
      </div>

      {/* Login card */}
      <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
        <div style={{ width:'100%', maxWidth:360, background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:10, padding:'32px 28px' }}>
          {/* Logo */}
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:28 }}>
            <svg width="36" height="36" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="19" stroke="var(--teal2)" strokeWidth="1.5"/>
              <circle cx="20" cy="20" r="12" stroke="var(--teal)" strokeWidth="1" opacity=".3"/>
              <circle cx="20" cy="20" r="5" fill="var(--teal)" opacity=".8"/>
            </svg>
            <div>
              <div style={{ fontSize:16, fontWeight:700, color:'var(--text)', letterSpacing:.5 }}>LanWealth AI</div>
              <div style={{ fontSize:11, color:'var(--muted)' }}>{g(T.loginTitle, locale)}</div>
            </div>
          </div>

          <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:14 }}>
            <div>
              <label style={{ display:'block', fontSize:12, color:'var(--muted)', marginBottom:5 }}>{g(T.emailLabel, locale)}</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
                style={{ width:'100%', background:'var(--bg3)', border:'1px solid var(--border2)', borderRadius:5, padding:'9px 12px', color:'var(--text)', fontSize:14, outline:'none' }}
                onFocus={e => (e.target.style.borderColor = 'var(--teal2)')}
                onBlur={e  => (e.target.style.borderColor = 'var(--border2)')} />
            </div>
            <div>
              <label style={{ display:'block', fontSize:12, color:'var(--muted)', marginBottom:5 }}>{g(T.passLabel, locale)}</label>
              <input type="password" value={password} onChange={e => setPass(e.target.value)} required
                style={{ width:'100%', background:'var(--bg3)', border:'1px solid var(--border2)', borderRadius:5, padding:'9px 12px', color:'var(--text)', fontSize:14, outline:'none' }}
                onFocus={e => (e.target.style.borderColor = 'var(--teal2)')}
                onBlur={e  => (e.target.style.borderColor = 'var(--border2)')} />
            </div>

            {error && (
              <div style={{ display:'flex', gap:8, alignItems:'center', background:'rgba(232,69,60,.1)', border:'1px solid rgba(232,69,60,.3)', borderRadius:5, padding:'8px 12px', color:'var(--red)', fontSize:13 }}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="6.5" cy="6.5" r="5.5"/><line x1="6.5" y1="4" x2="6.5" y2="7"/><circle cx="6.5" cy="9.5" r=".5" fill="currentColor" stroke="none"/>
                </svg>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              style={{ marginTop:4, padding:'10px', background:'var(--teal)', border:'none', borderRadius:6, color:'#050505', fontWeight:600, fontSize:14, cursor:loading?'not-allowed':'pointer', opacity:loading?.6:1, transition:'opacity .15s' }}>
              {loading ? '…' : g(T.loginBtn, locale)}
            </button>
          </form>

          <div style={{ marginTop:18, textAlign:'center' }}>
            <a href="https://app.lanwealth.com/auth/signup" target="_blank" rel="noreferrer"
              style={{ fontSize:12, color:'var(--muted)', cursor:'pointer' }}
              onMouseEnter={e => ((e.target as HTMLElement).style.color = 'var(--teal)')}
              onMouseLeave={e => ((e.target as HTMLElement).style.color = 'var(--muted)')}>
              {g(T.noAccount, locale)}
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
