// ============================================================================
// SECURITY ALERTS — shared by every function that guards a door to your brain
// ============================================================================
// Records each security event in the security_events table (your history)
// and sends you a Telegram message about it. To avoid alert floods, an event
// with the same dedup key only alerts once per time window — e.g. someone
// hammering a wrong password from one address pings you once an hour, not a
// thousand times.
//
// Never throws: a failed alert must never break the request it's about.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

const TITLES: Record<string, string> = {
  new_account: '🆕 A new account was created in your Open Brain',
  sign_in: '🔑 Someone signed in to your Open Brain app',
  mcp_bad_key: '🚫 Wrong access key used on your AI connection (MCP)',
  mcp_new_address: '🌐 An app connected to your brain (MCP) from a new internet address',
  mcp_new_app: '🔌 An app connected to your brain for the first time (or after 30 quiet days)',
  telegram_stranger: '👤 A stranger messaged your Telegram bot',
  telegram_forged: '🚫 A fake message (not from Telegram) was sent to your bot',
  digest_bad_secret: '🚫 Wrong password used on your weekly digest function',
  capture_unauthorized: '🚫 Someone without a login tried your capture functions',
}

// The caller's internet address, as Supabase passes it along
export function callerAddress(req: Request) {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
}

// Has this exact event (kind + dedupKey) already been recorded within the window?
async function seenRecently(kind: string, dedupKey: string, windowMinutes: number) {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString()
  const { count } = await admin
    .from('security_events')
    .select('id', { count: 'exact', head: true })
    .eq('kind', kind)
    .eq('dedup_key', dedupKey)
    .gte('created_at', since)
  return (count ?? 0) > 0
}

export async function securityAlert(
  kind: string,
  detail: Record<string, unknown>,
  opts: { dedupKey?: string; windowMinutes?: number } = {},
) {
  try {
    const dedupKey = opts.dedupKey ?? ''
    if (dedupKey && opts.windowMinutes && await seenRecently(kind, dedupKey, opts.windowMinutes)) return

    await admin.from('security_events').insert({ kind, detail, dedup_key: dedupKey || null })

    const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
    const chatId = Deno.env.get('TELEGRAM_CHAT_ID')
    if (!token || !chatId) return

    const lines = Object.entries(detail)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `• ${k.replace(/_/g, ' ')}: ${String(v).slice(0, 200)}`)
    const when = new Date().toLocaleString('en-US', { timeZone: 'America/Phoenix' })
    const text = `${TITLES[kind] ?? `⚠️ Security event: ${kind}`}\n${lines.join('\n')}\n• time: ${when} (Phoenix)\n\nNot you? Change your passwords and rotate your keys — see your Recovery Sheet.`

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch (err) {
    console.error('[security] alert failed (ignored):', String(err))
  }
}
