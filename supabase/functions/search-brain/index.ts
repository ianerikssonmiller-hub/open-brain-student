// ============================================================================
// SEARCH-BRAIN — the app's Search tab, upgraded to hybrid search
// ============================================================================
// Your app can't run hybrid search from the browser: it needs an embedding of
// the search phrase, and embeddings need your OpenAI key, which must never sit
// in a web page. So the app sends the phrase here, and this function:
//   1. works out WHO is asking from their own login token (never from the
//      request body — a browser could put anything there)
//   2. turns the phrase into an embedding via generate-embedding
//   3. runs search_thoughts (meaning + keywords + chunks) for that person only
//
// Unlike the Claude connection, this includes your 🔒 private thoughts — it's
// you, searching your own brain. (Private thoughts have no embedding, so they
// are found by keyword.) If the embedding fails, search falls back to
// keywords only instead of showing an error.
//
// Request:  POST { query: string, limit?: number }
// Response: { ok: true, results: [...] }   or   { ok: false, error }
// ============================================================================

import { admin, corsHeaders, getCaller, jsonResponse } from '../_shared/capture-common.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

async function embed(text: string, userId: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ text, userId, source: 'search-brain' }),
    })
    const { embedding } = await res.json()
    return Array.isArray(embedding) ? embedding : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const user = await getCaller(req)
    if (!user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const { query, limit } = await req.json()
    const text = String(query ?? '').trim()
    if (!text) return jsonResponse({ ok: false, error: 'Type something to search for' })
    const matchCount = Math.min(Math.max(Number(limit) || 20, 1), 50)

    const embedding = await embed(text, user.id)
    const { data, error } = await admin.rpc('search_thoughts', {
      query_text: text,
      p_user_id: user.id, // the caller's own id, from their login token
      query_embedding: embedding,
      match_count: matchCount,
      p_include_private: true,
    })
    if (error) throw error

    // Add each result's private flag so the app can show the 🔒 label
    const ids = (data ?? []).map((r: { id: string }) => r.id)
    const privateIds = new Set<string>()
    if (ids.length) {
      const { data: flags } = await admin
        .from('thoughts').select('id, is_private').in('id', ids).eq('user_id', user.id)
      for (const f of flags ?? []) if (f.is_private) privateIds.add(f.id)
    }
    const results = (data ?? []).map((r: { id: string }) => ({ ...r, is_private: privateIds.has(r.id) }))

    return jsonResponse({ ok: true, results, used_meaning: embedding !== null })
  } catch (err) {
    console.error('[search-brain] Failed:', String(err))
    return jsonResponse({ ok: false, error: String((err as Error).message ?? err) })
  }
})
