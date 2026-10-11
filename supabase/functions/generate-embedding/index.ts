// ============================================================================
// GENERATE-EMBEDDING — turns text into its "map coordinates" of meaning
// ============================================================================
// To switch embedding providers, change the model string. The vector dimension
// must stay 1536 or you need a new migration.
//
// Same gateway idea as call-llm: every embedding in your brain is made here,
// so the provider is chosen in ONE place, by Supabase secrets:
//   EMBEDDING_PROVIDER   'openai' (default) or 'openrouter'
//   EMBEDDING_MODEL      default 'text-embedding-3-small' (1,536 numbers)
//   OPENAI_API_KEY       needed for 'openai'  (you already have this)
//   OPENROUTER_API_KEY   needed for 'openrouter'
//
// Important: embeddings from different models don't mix. If you ever change
// the model, re-embed every thought (the backfill function does this).
//
// Request:  POST { text, userId?, source? }
// Response: { embedding: number[] }   — or { embedding: null } on any failure,
//           so callers can carry on without crashing.
//
// Only your own functions may call it (service role key), so nobody can use
// your public app key to spend your OpenAI credit.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const PROVIDER = (Deno.env.get('EMBEDDING_PROVIDER') ?? 'openai').toLowerCase()
const MODEL = Deno.env.get('EMBEDDING_MODEL') ?? 'text-embedding-3-small'
const DIMENSIONS = 1536
const MAX_CHARS = 16_000 // the model reads ~8,000 tokens at most; trim long transcripts safely under that

// Published price in US dollars per 1 million tokens, for llm_usage receipts
const PRICES: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'openai/text-embedding-3-small': 0.02,
}

const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE_KEY)

// Same check as call-llm: Supabase's front door (verify_jwt) has already
// verified the token, so read which role it was issued for.
function isServiceRole(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return false
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) return true
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)))
    return claims.role === 'service_role'
  } catch {
    return false
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Both providers speak the same "embeddings" format; only the address and key differ
const ENDPOINTS: Record<string, { url: string; keyName: string }> = {
  openai: { url: 'https://api.openai.com/v1/embeddings', keyName: 'OPENAI_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/embeddings', keyName: 'OPENROUTER_API_KEY' },
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ embedding: null, error: 'POST only' }, 405)
  if (!isServiceRole(req)) return json({ embedding: null, error: 'Unauthorized' }, 401)

  try {
    const { text, userId, source = 'unknown' } = await req.json()
    if (!text || typeof text !== 'string' || !text.trim()) {
      return json({ embedding: null, error: 'text is required' })
    }

    const endpoint = ENDPOINTS[PROVIDER]
    if (!endpoint) return json({ embedding: null, error: `Unknown EMBEDDING_PROVIDER "${PROVIDER}"` })
    const key = Deno.env.get(endpoint.keyName)
    if (!key) return json({ embedding: null, error: `${endpoint.keyName} secret is missing` })

    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input: text.slice(0, MAX_CHARS) }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json()
    if (!res.ok) {
      console.error('embedding API error:', res.status, data?.error?.message)
      return json({ embedding: null, error: data?.error?.message ?? `HTTP ${res.status}` })
    }

    const embedding: number[] | undefined = data?.data?.[0]?.embedding
    if (!Array.isArray(embedding) || embedding.length !== DIMENSIONS) {
      return json({ embedding: null, error: `Expected ${DIMENSIONS} numbers, got ${embedding?.length ?? 0}` })
    }

    // Receipt — never awaited, never allowed to fail the call
    const tokens = data?.usage?.prompt_tokens ?? 0
    if (userId) {
      try {
        const pending = admin.from('llm_usage').insert({
          user_id: userId,
          kind: 'embedding',
          model: MODEL,
          source,
          prompt_tokens: tokens,
          completion_tokens: 0,
          cost_usd: (tokens * (PRICES[MODEL] ?? 0)) / 1_000_000,
        }).then(({ error }) => {
          if (error) console.warn('llm_usage insert failed (ignored):', error.message)
        }, () => {})
        // deno-lint-ignore no-explicit-any
        ;(globalThis as any).EdgeRuntime?.waitUntil?.(pending)
      } catch { /* a failed receipt never fails the embedding */ }
    }

    return json({ embedding })
  } catch (err) {
    console.error('generate-embedding error:', err)
    return json({ embedding: null, error: String((err as Error).message ?? err) })
  }
})
