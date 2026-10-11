// ============================================================================
// SECURITY-ALERT — receives login events from your database
// ============================================================================
// A database trigger on your users table calls this whenever someone signs in
// to your app or a new account is created, and this sends you the alert.
//
// Deployed with --no-verify-jwt (the database has no Supabase login), so it
// checks its own password, ALERT_SECRET, instead.
// Request: POST { kind: 'sign_in' | 'new_account', detail: {...} }
// ============================================================================

import { securityAlert } from '../_shared/security.ts'

const ALERT_SECRET = Deno.env.get('ALERT_SECRET') ?? ''
const ALLOWED_KINDS = new Set(['sign_in', 'new_account'])

function safeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  if (!ALERT_SECRET || !safeEqual(req.headers.get('x-alert-secret') ?? '', ALERT_SECRET)) {
    return new Response('Unauthorized', { status: 401 })
  }
  try {
    const { kind, detail } = await req.json()
    if (!ALLOWED_KINDS.has(kind)) return new Response('Unknown kind', { status: 400 })
    await securityAlert(kind, detail ?? {})
    return new Response('ok')
  } catch {
    return new Response('ok') // never make the database retry
  }
})
