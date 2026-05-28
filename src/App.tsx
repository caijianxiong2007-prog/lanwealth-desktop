import { useState, useEffect } from 'react'
import { getSession, supabase } from './lib/supabase'
import type { UserSession }     from './lib/supabase'
import LoginPage                from './pages/LoginPage'
import ChatPage                 from './pages/ChatPage'

export default function App() {
  const [session, setSession] = useState<UserSession | null | undefined>(undefined)

  useEffect(() => {
    getSession().then(s => setSession(s))
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, s) => {
      if (s) setSession({ id: s.user.id, email: s.user.email!, access_token: s.access_token })
      else   setSession(null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Loading splash
  if (session === undefined) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
                  height:'100vh', background:'var(--bg)', color:'var(--teal)' }}>
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" strokeDasharray="30 15">
          <animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="1s" repeatCount="indefinite"/>
        </circle>
      </svg>
    </div>
  )

  return session
    ? <ChatPage session={session} onSignOut={() => setSession(null)} />
    : <LoginPage onSuccess={s => setSession(s)} />
}
