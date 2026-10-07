// ============================================================================
// SHARED PIECES FOR capture-url AND capture-youtube
// ============================================================================
// Who is calling, how to answer, and how to save — written once so both
// capture functions behave the same way.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Always 200 with an ok flag, so the app can show the friendly error message
// instead of a generic "function returned an error".
export function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// The service role key skips the Level 2 security rule. That is fine here
// because we only ever write rows for the user we identified below.
export const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

// Who is asking? Read from their login token — never from the request body,
// or anyone could write into anyone else's brain.
export async function getCaller(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

// Same save your Level 2 app does: one thought row, plus the full text in
// thought_sources. No summarising yet — Level 5 adds that.
export async function saveCapture(opts: {
  userId: string
  content: string
  metadata: Record<string, unknown>
  sourceText: string
  sourceKind: string
}) {
  const { data: thought, error } = await admin
    .from('thoughts')
    .insert({ user_id: opts.userId, content: opts.content, metadata: opts.metadata })
    .select('id')
    .single()
  if (error) throw error

  // Non-fatal: the thought is already saved either way, same rule as Level 2.
  const { error: srcError } = await admin.from('thought_sources').insert({
    thought_id: thought.id,
    user_id: opts.userId,
    source_text: opts.sourceText,
    source_kind: opts.sourceKind,
    char_count: opts.sourceText.length,
    truncated: false,
  })
  if (srcError) console.warn('thought_sources insert failed:', srcError.message)

  return thought.id as string
}
