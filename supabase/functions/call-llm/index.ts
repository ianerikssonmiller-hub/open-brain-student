// ============================================================================
// CALL-LLM — YOUR LLM GATEWAY
// ============================================================================
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new
// provider's API key. No other code changes needed.
//
// Every AI call your agents make comes through this one function. No agent
// knows or cares which AI answers — they just send a prompt and get text back.
//
// Secrets it reads (Supabase -> Edge Functions -> Secrets):
//   LLM_PROVIDER          'openai' or 'anthropic'
//   LLM_MODEL             the model name, e.g. a small cheap model for tagging
//   LLM_REASONING_EFFORT  optional, OpenAI only: 'minimal'/'low' for reasoning
//                         models, so they answer quickly and cheaply
//   OPENAI_API_KEY        needed when LLM_PROVIDER is 'openai'
//   ANTHROPIC_API_KEY     needed when LLM_PROVIDER is 'anthropic'
// Provided automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Request:  POST { prompt, systemPrompt?, model?, maxTokens?, userId?, source? }
// Response: { text }   or   { error }
//
// WHO MAY CALL IT: only your own functions (they send the service role key).
// Your app's public key is in config.js for anyone to read — without this
// check, a stranger could use it to spend your AI credit.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const PROVIDER = (Deno.env.get('LLM_PROVIDER') ?? 'anthropic').toLowerCase()
const DEFAULT_MODEL = Deno.env.get('LLM_MODEL') ?? ''
const REASONING_EFFORT = Deno.env.get('LLM_REASONING_EFFORT') ?? ''

const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE_KEY)

// Published prices in US dollars per 1 million tokens [input, output], used
// only to estimate cost for your llm_usage receipts. A model not listed here
// is logged with cost 0 — add it when you switch. Check your provider's
// pricing page; these numbers change.
const PRICES: Record<string, [number, number]> = {
  'gpt-5-nano': [0.05, 0.40],
  'gpt-5-mini': [0.25, 2.00],
  'gpt-4.1-nano': [0.10, 0.40],
  'gpt-4.1-mini': [0.40, 1.60],
  'claude-haiku-4-5': [1.00, 5.00],
}

function estimateCost(model: string, inTokens: number, outTokens: number) {
  // Match "claude-haiku-4-5-20251001" to "claude-haiku-4-5", etc.
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(k + '-'))
  if (!key) return 0
  const [inPrice, outPrice] = PRICES[key]
  return (inTokens * inPrice + outTokens * outPrice) / 1_000_000
}

// Is the caller using the service role key? Supabase's front door (verify_jwt,
// on for this function) has already checked the token's signature, so we only
// need to read which role it was issued for. Comparing the raw text is not
// enough: the copy of the key Supabase gives your functions is not always
// character-for-character the same as the one in your dashboard.
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

// ---------------------------------------------------------------------------
// PROVIDERS — each one turns a prompt into { text, inTokens, outTokens }.
// Adding a new provider means adding one function here.
// ---------------------------------------------------------------------------
interface LlmResult { text: string; inTokens: number; outTokens: number }

async function callOpenAI(model: string, prompt: string, systemPrompt: string, maxTokens: number): Promise<LlmResult> {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key) throw new Error('OPENAI_API_KEY secret is missing')
  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      { role: 'user', content: prompt },
    ],
    max_completion_tokens: maxTokens,
  }
  if (REASONING_EFFORT) body.reasoning_effort = REASONING_EFFORT
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message ?? 'unknown error'}`)
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    inTokens: data.usage?.prompt_tokens ?? 0,
    outTokens: data.usage?.completion_tokens ?? 0,
  }
}

async function callAnthropic(model: string, prompt: string, systemPrompt: string, maxTokens: number): Promise<LlmResult> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) throw new Error('ANTHROPIC_API_KEY secret is missing')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message ?? 'unknown error'}`)
  return {
    // deno-lint-ignore no-explicit-any
    text: (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''),
    inTokens: data.usage?.input_tokens ?? 0,
    outTokens: data.usage?.output_tokens ?? 0,
  }
}

const PROVIDERS: Record<string, typeof callOpenAI> = {
  openai: callOpenAI,
  anthropic: callAnthropic,
}

// ---------------------------------------------------------------------------
// THE RECEIPT — never awaited, never allowed to fail the call
// ---------------------------------------------------------------------------
function logUsage(userId: string | undefined, model: string, source: string, r: LlmResult) {
  if (!userId) return // llm_usage needs an owner; nothing to bill
  try {
    const pending = admin.from('llm_usage').insert({
      user_id: userId,
      kind: 'chat',
      model,
      source,
      prompt_tokens: r.inTokens,
      completion_tokens: r.outTokens,
      cost_usd: estimateCost(model, r.inTokens, r.outTokens),
    }).then(({ error }) => {
      if (error) console.warn('llm_usage insert failed (ignored):', error.message)
    }, () => {})
    // Let the receipt finish writing after the response has been sent
    // deno-lint-ignore no-explicit-any
    ;(globalThis as any).EdgeRuntime?.waitUntil?.(pending)
  } catch { /* a failed receipt must never fail the call — the AI already answered */ }
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  // Only your own functions may spend your AI credit
  if (!isServiceRole(req)) return json({ error: 'Unauthorized' }, 401)

  try {
    const { prompt, systemPrompt = '', model, maxTokens = 800, userId, source = 'unknown' } = await req.json()
    if (!prompt || typeof prompt !== 'string') return json({ error: 'prompt is required' }, 400)

    const useModel = model || DEFAULT_MODEL
    if (!useModel) return json({ error: 'No model set — add LLM_MODEL in Supabase secrets' }, 500)

    const provider = PROVIDERS[PROVIDER]
    if (!provider) return json({ error: `Unknown LLM_PROVIDER "${PROVIDER}" — use openai or anthropic` }, 500)

    const result = await provider(useModel, prompt, systemPrompt, maxTokens)
    logUsage(userId, useModel, source, result)
    return json({ text: result.text })
  } catch (err) {
    console.error('call-llm error:', err)
    return json({ error: String((err as Error).message ?? err) }, 502)
  }
})
