// ============================================================================
// BACKFILL-CHUNKS — chunk long captures saved before chunking existed
// ============================================================================
// Works through the thoughts_needing_chunks list (long, non-private thoughts
// with no chunks yet), biggest documents first — they matter most if the run
// gets interrupted. Call it in a loop until remaining is 0; it picks up where
// it left off, because a chunked thought drops off the list.
//
// Request:  POST { batch_size?: number (default 10), dry_run?: boolean }
// Response: { processed, chunked, remaining }   or, for dry_run, { needs_chunks }
//
// Only callable with the service role key.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE_KEY)

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

async function countRemaining() {
  const { count } = await admin.from('thoughts_needing_chunks').select('id', { count: 'exact', head: true })
  return count ?? 0
}

Deno.serve(async (req) => {
  if (!isServiceRole(req)) return json({ error: 'Unauthorized' }, 401)

  try {
    const body = await req.json().catch(() => ({}))
    if (body.dry_run) return json({ needs_chunks: await countRemaining() })
    const batchSize = Math.min(Math.max(Number(body.batch_size) || 10, 1), 20)

    const { data: todo, error } = await admin
      .from('thoughts_needing_chunks')
      .select('id')
      .order('chars', { ascending: false })
      .limit(batchSize)
    if (error) throw error

    let chunked = 0
    for (const { id } of todo ?? []) {
      const { data: t } = await admin.from('thoughts').select('id, content, user_id').eq('id', id).single()
      if (!t) continue
      const n = await saveThoughtChunksSafe(admin, t.id, t.content, 'backfill-chunks', 'summary', t.user_id)
      if (n > 0) chunked++
    }

    return json({ processed: todo?.length ?? 0, chunked, remaining: await countRemaining() })
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 500)
  }
})
