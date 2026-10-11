// ============================================================================
// BACKFILL-EMBEDDINGS — catch up thoughts saved before embeddings existed
// ============================================================================
// Runs in small batches. Each call embeds up to batch_size thoughts that have
// no embedding yet, and tells you how many are left. Call it in a loop until
// remaining is 0.
//
// Skips the same thoughts enrich-thought skips: private (🔒), digests, and
// very short ones. Thoughts with no owner (early test rows) are left alone.
//
// Request:  POST { batch_size?: number (default 5), offset?: number }
// Response: { processed, embedded, failed, skipped, offset_next, remaining }
//
// Only callable with the service role key.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

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

// The thoughts still waiting for an embedding
function pending() {
  return admin
    .from('thoughts')
    .select('id, content, user_id', { count: 'exact' })
    .is('embedding', null)
    .eq('is_private', false)
    .not('user_id', 'is', null)
    .or('category.is.null,category.neq.digest')
}

Deno.serve(async (req) => {
  if (!isServiceRole(req)) return json({ error: 'Unauthorized' }, 401)

  try {
    const body = await req.json().catch(() => ({}))
    const batchSize = Math.min(Math.max(Number(body.batch_size) || 5, 1), 20)
    const offset = Math.max(Number(body.offset) || 0, 0)

    // Embedded thoughts drop out of this list, so "offset" only has to step
    // past the ones we skipped or failed on.
    const { data: rows, error } = await pending()
      .order('created_at', { ascending: true })
      .range(offset, offset + batchSize - 1)
    if (error) throw error

    let embedded = 0, failed = 0, skipped = 0
    for (const t of rows ?? []) {
      if (!t.content || t.content.trim().length < 20) { skipped++; continue }
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
          body: JSON.stringify({ text: t.content, userId: t.user_id, source: 'backfill-embeddings' }),
        })
        const { embedding } = await res.json()
        if (!embedding) { failed++; continue }
        const { error: upErr } = await admin.from('thoughts').update({ embedding }).eq('id', t.id)
        if (upErr) { failed++; continue }
        embedded++
      } catch {
        failed++ // one bad thought never stops the batch
      }
    }

    const offsetNext = offset + failed + skipped
    const { count } = await pending().range(0, 0)
    const remaining = Math.max((count ?? 0) - offsetNext, 0)

    return json({ processed: rows?.length ?? 0, embedded, failed, skipped, offset_next: offsetNext, remaining })
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 500)
  }
})
