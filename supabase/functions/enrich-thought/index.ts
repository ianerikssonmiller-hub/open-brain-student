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
//
// Level 6: it also creates the thought's embedding (its meaning as 1,536
// numbers) through generate-embedding, so meaning-based search can find it,
// and links it to its closest neighbours in thought_links (the thought graph).
// Level 7: long captures are also split into chunks (thought_chunks), each
// with its own embedding, so a buried detail can be found.
//   - very short thoughts (under 20 characters) — nothing worth tagging
//   - weekly digests — they are already a summary
//   - anything already enriched
//
// It always answers 200: a webhook that gets an error just retries or gives
// up, and the thought is already saved either way.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

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

// ---------------------------------------------------------------------------
// TAGS, CATEGORY, SUMMARY — ask the AI through the call-llm gateway
// ---------------------------------------------------------------------------
async function tagThought(thought: { id: string; content: string; user_id: string }) {
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
  if (!llmRes.ok || !llm.text) return `tagging failed: ${llm.error ?? llmRes.status}`

  const parsed = parseJson(llm.text)
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
    : []
  // Accept near-misses like "Plan" or "planning"; if the AI invents
  // something else entirely, leave the category as it was
  const rawCategory = String(parsed.category ?? '').toLowerCase()
  const category = CATEGORIES.find((c) => rawCategory.includes(c)) ?? null
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 400) : null

  const { error } = await admin
    .from('thoughts')
    .update({
      tags,
      summary,
      enriched_at: new Date().toISOString(),
      ...(category ? { category } : {}),
    })
    .eq('id', thought.id)
  if (error) return `tag update failed: ${error.message}`
  return `tagged [${tags.join(', ')}] ${category ?? ''}`.trim()
}

// ---------------------------------------------------------------------------
// EMBEDDING — the thought's "map coordinates" of meaning
// ---------------------------------------------------------------------------
// NOTE the Authorization header — it is not optional. One edge function calling
// another must prove who it is, or Supabase rejects the call with a 401 before
// generate-embedding runs. The symptom is that embeddings silently never appear
// and the generate-embedding logs are empty, because it never ran.
async function embedThought(thought: { id: string; content: string; user_id: string }) {
  const embRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ text: thought.content, userId: thought.user_id, source: 'enrich-thought' }),
  })
  const { embedding, error } = await embRes.json()
  if (!embedding) return { note: `embedding failed: ${error ?? embRes.status}`, embedding: null }

  const { error: updateError } = await admin.from('thoughts').update({ embedding }).eq('id', thought.id)
  if (updateError) return { note: `embedding save failed: ${updateError.message}`, embedding: null }
  return { note: 'embedded', embedding: embedding as number[] }
}

// ---------------------------------------------------------------------------
// AUTO-LINK — tie this thought to its nearest neighbours in meaning
// ---------------------------------------------------------------------------
// Scoped to the thought's own owner (p_user_id): this runs with the service
// role key, which skips every login rule, so the filter has to be explicit.
async function linkThought(thoughtId: string, userId: string, embedding: number[]) {
  const { data: neighbors, error } = await admin.rpc('find_links_for_thought', {
    source_id: thoughtId,
    source_embedding: embedding,
    p_user_id: userId,
    match_threshold: 0.5,
    match_count: 5,
  })
  if (error) return `linking failed: ${error.message}`
  if (!neighbors?.length) return 'no close neighbours yet'

  const links = neighbors.map((n: { target_id: string; similarity: number }) => ({
    source_thought_id: thoughtId,
    target_thought_id: n.target_id,
    user_id: userId, // without this, links would be unowned and invisible to you
    similarity_score: n.similarity,
    link_type: 'semantic',
  }))

  // ignoreDuplicates: an existing link is skipped — no errors, no overwrites.
  // (A reverse duplicate B→A is refused by the database; insert one at a time
  // so one refusal doesn't drop the others.)
  let saved = 0
  for (const link of links) {
    const { error: linkErr } = await admin
      .from('thought_links')
      .upsert(link, { onConflict: 'source_thought_id,target_thought_id', ignoreDuplicates: true })
    if (!linkErr) saved++
  }
  return `linked to ${saved} neighbour(s)`
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
      .select('id, content, user_id, is_private, category, enriched_at, embedding')
      .eq('id', id)
      .single()
    if (error || !thought) return ok(`thought ${id} not found — skipped`)

    // Private thoughts never go to an AI — not for tags, not for embeddings
    if (thought.is_private) return ok(`${id} is private — skipped`)
    if (thought.category === 'digest') return ok(`${id} is a digest — skipped`)
    if (!thought.content || thought.content.trim().length < 20) return ok(`${id} too short — skipped`)

    // Each step is independent: if tagging fails, the embedding still happens
    const notes: string[] = []
    if (!thought.enriched_at) {
      try { notes.push(await tagThought(thought)) } catch (e) { notes.push(`tagging error: ${e}`) }
    }
    if (!thought.embedding) {
      try {
        const { note, embedding } = await embedThought(thought)
        notes.push(note)
        // Only link when we have coordinates — if embedding failed, skip, don't crash
        if (embedding) notes.push(await linkThought(thought.id, thought.user_id, embedding))
      } catch (e) {
        notes.push(`embedding/linking error: ${e}`)
      }
    }

    // Level 7: chunk it, if it's long enough to be worth it (over 2,000
    // characters — saveThoughtChunksSafe quietly does nothing otherwise, and
    // never throws). A long transcript can mean dozens of embedding calls, so
    // this finishes in the background after we've answered the webhook.
    if (thought.content.length > 2000) {
      const chunking = saveThoughtChunksSafe(
        admin, thought.id, thought.content, 'enrich-thought', 'summary', thought.user_id,
      ).then((n) => console.log(`[enrich] ${id}: ${n} chunk(s) saved`))
      // deno-lint-ignore no-explicit-any
      const runtime = (globalThis as any).EdgeRuntime
      if (runtime?.waitUntil) runtime.waitUntil(chunking)
      else await chunking
      notes.push('chunking started')
    }

    return ok(`${id}: ${notes.join('; ') || 'nothing to do'}`)
  } catch (err) {
    return ok(`error: ${String((err as Error).message ?? err)}`)
  }
})
