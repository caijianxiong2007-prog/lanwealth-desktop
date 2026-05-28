import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL      = import.meta.env.SUPABASE_URL      as string
const SUPABASE_ANON_KEY = import.meta.env.SUPABASE_ANON_KEY as string

// Browser client — session stored in localStorage
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    storageKey:     'lw_session',
    autoRefreshToken: true,
  },
})

export type UserSession = {
  id:           string
  email:        string
  access_token: string
}

export async function getSession(): Promise<UserSession | null> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  return { id: session.user.id, email: session.user.email!, access_token: session.access_token }
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password })
}

export async function signOut() {
  return supabase.auth.signOut()
}
