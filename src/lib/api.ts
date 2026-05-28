// Calls app.lanwealth.com API — uses Supabase access_token as Bearer

const APP_URL = import.meta.env.APP_URL as string   // https://app.lanwealth.com

export const MODELS = [
  { id: 'deepseek-v3',      name: 'DeepSeek V3',      tag: 'Fast',      price: '$0.27/M', group: 'DeepSeek' },
  { id: 'deepseek-r1',      name: 'DeepSeek R1',      tag: 'Reasoning', price: '$0.83/M', group: 'DeepSeek' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tag: 'Fast',      price: '$0.15/M', group: 'Google'   },
  { id: 'gemini-2.5-pro',   name: 'Gemini 2.5 Pro',   tag: 'Advanced',  price: '$1.25/M', group: 'Google'   },
  { id: 'claude-haiku',     name: 'Claude Haiku',      tag: 'Fast',      price: '$0.44/M', group: 'Claude'   },
  { id: 'claude-sonnet-4',  name: 'Claude Sonnet 4',  tag: 'Balanced',  price: '$1.65/M', group: 'Claude'   },
  { id: 'claude-opus-4',    name: 'Claude Opus 4',    tag: 'Powerful',  price: '$2.75/M', group: 'Claude'   },
  { id: 'gpt-4o-mini',      name: 'GPT-4o mini',      tag: 'Fast',      price: '$0.08/M', group: 'OpenAI'   },
  { id: 'gpt-4o',           name: 'GPT-4o',           tag: 'Balanced',  price: '$1.38/M', group: 'OpenAI'   },
]

export type Message = { role: 'user' | 'assistant'; content: string }

export async function* streamChat(
  accessToken: string,
  model: string,
  messages: Message[],
): AsyncGenerator<string> {
  const res = await fetch(`${APP_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body:    JSON.stringify({ model, messages }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(data.error ?? `HTTP ${res.status}`)
  }

  const reader  = res.body!.getReader()
  const decoder = new TextDecoder()
  let   buf     = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') return
      try {
        const delta = (JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] })
          .choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch { /* ignore malformed chunks */ }
    }
  }
}
