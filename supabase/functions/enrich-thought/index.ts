// ============================================================================
// ENRICH-THOUGHT — YOUR FIRST AGENT
// ============================================================================
// Runs automatically every time a new thought is saved. A Supabase Database
// Webhook calls this function with the new row; we ask the AI (through your
// call-llm gateway) for tags, a category and a one-sentence summary, and
// write them back onto the thought.
//
// It skips:
//   - thoughts saved as private (🔒) — they never go to an AI
//   - very short thoughts (under 20 characters) — nothing worth tagging
//   - weekly digests — they are already a summary
//   - anything already enriched
//
// It always answers 200: a webhook that gets an error just retries or gives
// up, and the thought is already saved either way.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection']
const MAX_INPUT_CHARS = 8000 // long transcripts: the opening is plenty to tag

const SYSTEM_PROMPT =
  'You organise notes in a personal knowledge base. You reply with JSON only — ' +
  'no explanation, no code fences.'

function buildPrompt(content: string) {
  return (
    'Read this saved note and return a JSON object with exactly these keys:\n' +
    '  "tags": an array of 3 to 5 short lowercase tags (one or two words each)\n' +
    `  "category": exactly one of ${CATEGORIES.map((c) => `"${c}"`).join(', ')}\n` +
    '  "summary": one sentence, at most 30 words, saying what the note is about\n\n' +
    'Note:\n"""\n' + content.slice(0, MAX_INPUT_CHARS) + '\n"""'
  )
}

// The AI sometimes wraps JSON in ```fences``` or adds a word before it.
// Pull out the first {...} block and parse that.
function parseJson(text: string) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('No JSON in AI reply: ' + text.slice(0, 200))
  return JSON.parse(text.slice(start, end + 1))
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

const ok = (note: string) => {
  console.log('[enrich]', note)
  return new Response(JSON.stringify({ ok: true, note }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  // Only the webhook (which sends the service role key) may run this agent —
  // otherwise anyone with your public app key could spend your AI credit.
  if (!isServiceRole(req)) return new Response('Unauthorized', { status: 401 })

  try {
    const payload = await req.json()
    const id = payload?.record?.id
    if (payload?.type !== 'INSERT' || !id) return ok('not an insert — skipped')

    // Re-read the row from the database rather than trusting the payload
    const { data: thought, error } = await admin
      .from('thoughts')
      .select('id, content, user_id, is_private, category, enriched_at')
      .eq('id', id)
      .single()
    if (error || !thought) return ok(`thought ${id} not found — skipped`)

    if (thought.is_private) return ok(`${id} is private — skipped`)
    if (thought.enriched_at) return ok(`${id} already enriched — skipped`)
    if (thought.category === 'digest') return ok(`${id} is a digest — skipped`)
    if (!thought.content || thought.content.trim().length < 20) return ok(`${id} too short — skipped`)

    // Ask the AI — through the gateway, never directly
    const llmRes = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        prompt: buildPrompt(thought.content),
        maxTokens: 600,
        userId: thought.user_id,
        source: 'enrich-thought',
      }),
    })
    const llm = await llmRes.json()
    if (!llmRes.ok || !llm.text) return ok(`call-llm failed for ${id}: ${llm.error ?? llmRes.status}`)

    const parsed = parseJson(llm.text)
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
      : []
    // Accept near-misses like "Plan" or "planning"; if the AI invents
    // something else entirely, leave the category as it was
    const rawCategory = String(parsed.category ?? '').toLowerCase()
    const category = CATEGORIES.find((c) => rawCategory.includes(c)) ?? null
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 400) : null

    const { error: updateError } = await admin
      .from('thoughts')
      .update({
        tags,
        summary,
        enriched_at: new Date().toISOString(),
        ...(category ? { category } : {}),
      })
      .eq('id', id)
    if (updateError) return ok(`update failed for ${id}: ${updateError.message}`)

    return ok(`enriched ${id}: [${tags.join(', ')}] ${category}`)
  } catch (err) {
    return ok(`error: ${String((err as Error).message ?? err)}`)
  }
})
