// Calls app.lanwealth.com API — uses Supabase access_token as Bearer
// 基址走 baseUrl.ts 容灾解析(主域被墙时自动切备用域)

import { apiFetch } from './baseUrl'

// 2026-08-03 换代 + 报价校正:此前清单停在两代前(DeepSeek V3/R1、Gemini 2.5、
// Claude Sonnet 4、GPT-4o),且标价与实扣严重不符(Sonnet 标 $1.65 实扣 $3.75,差 2.3 倍);
// claude-opus-4 在网关根本没有对应 model_name,选它会被静默降级到 DeepSeek。
// 现清单与网页端 ChatClient.tsx MODELS 同源,price = 输入价/百万 token(与定价页一致)。
export const MODELS = [
  { id: 'deepseek-v4-flash',     name: 'DeepSeek V4 Flash',     tag: 'Fast',      price: '$0.34/M', group: 'DeepSeek'  },
  { id: 'deepseek-v4-pro',       name: 'DeepSeek V4 Pro',       tag: 'Reasoning', price: '$0.69/M', group: 'DeepSeek'  },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', tag: 'Fast',      price: '$0.38/M', group: 'Google'    },
  { id: 'gemini-3.6-flash',      name: 'Gemini 3.6 Flash',      tag: 'Advanced',  price: '$1.88/M', group: 'Google'    },
  { id: 'claude-haiku-4-5',      name: 'Claude Haiku 4.5',      tag: 'Fast',      price: '$1.25/M', group: 'Claude'    },
  { id: 'claude-sonnet-5',       name: 'Claude Sonnet 5',       tag: 'Balanced',  price: '$3.75/M', group: 'Claude'    },
  { id: 'claude-opus-5',         name: 'Claude Opus 5',         tag: 'Powerful',  price: '$6.25/M', group: 'Claude'    },
  { id: 'gpt-5.4-mini',          name: 'GPT-5.4 mini',          tag: 'Fast',      price: '$0.94/M', group: 'OpenAI'    },
  { id: 'gpt-5.6-terra',         name: 'GPT-5.6 Terra',         tag: 'Balanced',  price: '$3.13/M', group: 'OpenAI'    },
  { id: 'gpt-5.6-sol',           name: 'GPT-5.6 Sol',           tag: 'Powerful',  price: '$6.25/M', group: 'OpenAI'    },
  { id: 'qwen3.5-flash',         name: 'Qwen3.5 Flash',         tag: 'Fast',      price: '$0.13/M', group: 'Qwen'      },
  { id: 'qwen-plus',             name: 'Qwen Plus',             tag: 'Balanced',  price: '$0.50/M', group: 'Qwen'      },
  { id: 'doubao-seed-pro',       name: 'Doubao 2.1 Turbo',      tag: 'Balanced',  price: '$0.51/M', group: 'ByteDance' },
  { id: 'glm-5.2',               name: 'GLM-5.2',               tag: 'Advanced',  price: '$1.37/M', group: 'Zhipu'     },
]

export type Message = { role: 'user' | 'assistant'; content: string }

export async function* streamChat(
  accessToken: string,
  model: string,
  messages: Message[],
): AsyncGenerator<string> {
  const res = await apiFetch('/api/chat', {
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
