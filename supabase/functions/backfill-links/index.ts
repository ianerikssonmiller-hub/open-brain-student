// ============================================================================
// BACKFILL-LINKS — build the graph for thoughts saved before linking existed
// ============================================================================
// Walks through every thought that has an embedding, a few at a time, finds
// its nearest neighbours (over 50% similar) and saves the links. Call it in a
// loop until remaining is 0. Safe to re-run: thoughts that already have their
// own outgoing links are skipped, and duplicate links are ignored.
//
// Request:  POST { batch_size?: number (default 3), offset?: number }
// Response: { processed, linked, already_done, offset_next, remaining }
//
// Small batches on purpose — Supabase stops functions that work too long
// (a "546" error), and each thought makes several database calls.
// Only callable with the service role key.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

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

function withEmbeddings(select: string, opts?: { count: 'exact'; head?: boolean }) {
  return admin
    .from('thoughts')
    .select(select, opts)
    .not('embedding', 'is', null)
    .not('user_id', 'is', null)
    .eq('is_private', false)
}

Deno.serve(async (req) => {
  if (!isServiceRole(req)) return json({ error: 'Unauthorized' }, 401)

  try {
    const body = await req.json().catch(() => ({}))
    const batchSize = Math.min(Math.max(Number(body.batch_size) || 3, 1), 10)
    const offset = Math.max(Number(body.offset) || 0, 0)

    const { data: rows, error } = await withEmbeddings('id, user_id, embedding')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + batchSize - 1)
    if (error) throw error

    let linked = 0, alreadyDone = 0
    // deno-lint-ignore no-explicit-any
    for (const t of (rows ?? []) as any[]) {
      // Already has its own neighbours? Skip.
      const { count } = await admin
        .from('thought_links')
        .select('id', { count: 'exact', head: true })
        .eq('source_thought_id', t.id)
      if ((count ?? 0) > 0) { alreadyDone++; continue }

      const { data: neighbors, error: rpcErr } = await admin.rpc('find_links_for_thought', {
        source_id: t.id,
        source_embedding: t.embedding,
        p_user_id: t.user_id,
        match_threshold: 0.5,
        match_count: 5,
      })
      if (rpcErr || !neighbors?.length) continue

      // One at a time, so a refused reverse duplicate (B→A when A→B exists)
      // doesn't drop the rest
      for (const n of neighbors as { target_id: string; similarity: number }[]) {
        const { error: linkErr } = await admin.from('thought_links').upsert({
          source_thought_id: t.id,
          target_thought_id: n.target_id,
          user_id: t.user_id,
          similarity_score: n.similarity,
          link_type: 'semantic',
        }, { onConflict: 'source_thought_id,target_thought_id', ignoreDuplicates: true })
        if (!linkErr) linked++
      }
    }

    const offsetNext = offset + (rows?.length ?? 0)
    const { count: total } = await withEmbeddings('id', { count: 'exact', head: true })
    return json({
      processed: rows?.length ?? 0,
      linked,
      already_done: alreadyDone,
      offset_next: offsetNext,
      remaining: Math.max((total ?? 0) - offsetNext, 0),
    })
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 500)
  }
})
