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
//
// One exception: your own server functions (like the Telegram bot) call these
// capture functions with the service role key and say which user to save for
// in body.user_id. That's safe because only your functions hold that key —
// and Supabase's front door (verify_jwt, on for the capture functions) has
// already verified the token before we read which role it was issued for.
export async function getCaller(req: Request, body?: { user_id?: unknown }) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  if (isServiceRoleToken(token)) {
    return typeof body?.user_id === 'string' && body.user_id ? { id: body.user_id } : null
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) return null
  return { id: data.user.id }
}

function isServiceRoleToken(token: string) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)))
    return claims.role === 'service_role'
  } catch {
    return false
  }
}

// Same save your Level 2 app does: one thought row, plus the full text in
// thought_sources. No summarising yet — Level 5 adds that.
export async function saveCapture(opts: {
  userId: string
  content: string
  metadata: Record<string, unknown>
  sourceText: string
  sourceKind: string
  isPrivate?: boolean
}) {
  const { data: thought, error } = await admin
    .from('thoughts')
    // upsert: capturing the same page/video twice updates instead of duplicating
    // is_private is only ever sent as true, so a re-capture can't make it public
    .upsert({
      user_id: opts.userId,
      content: opts.content,
      metadata: opts.metadata,
      ...(opts.isPrivate ? { is_private: true } : {}),
    }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
    .select('id')
    .single()
  if (error) throw error

  // Non-fatal: the thought is already saved either way, same rule as Level 2.
  const { error: srcError } = await admin.from('thought_sources').upsert({
    thought_id: thought.id,
    user_id: opts.userId,
    source_text: opts.sourceText,
    source_kind: opts.sourceKind,
    char_count: opts.sourceText.length,
    truncated: false,
  }, { onConflict: 'thought_id' })
  if (srcError) console.warn('thought_sources insert failed:', srcError.message)

  return thought.id as string
}
