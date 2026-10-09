// ============================================================================
// WEEKLY-DIGEST — YOUR SECOND AGENT
// ============================================================================
// Every Sunday morning, pg_cron (the scheduler inside your database) calls
// this function. It reads your last 7 days of thoughts, asks the AI (through
// your call-llm gateway) what you have been learning, and saves the report
// back into your brain as a thought with category 'digest'. If your Telegram
// bot is set up, it also sends you the report there.
//
// Private (🔒) thoughts are never included. Earlier digests are skipped too,
// so a digest never summarises a digest.
//
// Secrets it reads:
//   DIGEST_SECRET       password the scheduler sends — only it may run this
//   OWNER_USER_ID       whose thoughts to read, and who the digest belongs to
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   optional: also send it to Telegram
//   DIGEST_TELEGRAM     optional: set to 'off' to stop the Telegram copy
// Provided automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deployed with --no-verify-jwt: the scheduler has no Supabase login, so this
// function checks DIGEST_SECRET itself instead.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const DIGEST_SECRET = Deno.env.get('DIGEST_SECRET') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''
const TELEGRAM_ON = (Deno.env.get('DIGEST_TELEGRAM') ?? 'on').toLowerCase() !== 'off'

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const MIN_THOUGHTS = 5          // fewer than this isn't worth a report
const MAX_INPUT_CHARS = 14_000  // keeps each digest to a fraction of a cent

const SYSTEM_PROMPT =
  'You write a short weekly review of what someone captured in their personal ' +
  'knowledge base. Write to them directly ("you"). Be specific — name the actual ' +
  'ideas, people and sources. Plain text, no markdown headings or bold.'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Constant-time password comparison
function safeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!DIGEST_SECRET || !safeEqual(req.headers.get('x-digest-secret') ?? '', DIGEST_SECRET)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    // 1. The last 7 days, minus private thoughts and earlier digests
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: thoughts, error } = await admin
      .from('thoughts')
      .select('content, created_at, category, tags, summary')
      .eq('user_id', OWNER_USER_ID)
      .eq('is_private', false)
      .gte('created_at', since)
      .or('category.is.null,category.neq.digest')
      .order('created_at', { ascending: true })
    if (error) throw error

    if (!thoughts || thoughts.length < MIN_THOUGHTS) {
      const note = `Only ${thoughts?.length ?? 0} thoughts this week — no digest (need ${MIN_THOUGHTS}).`
      console.log('[digest]', note)
      return json({ ok: true, skipped: true, note })
    }

    // 2. Group by category; use the one-line summary where enrichment made one
    const groups: Record<string, string[]> = {}
    for (const t of thoughts) {
      const cat = t.category && t.category !== 'general' ? t.category : 'uncategorised'
      const line = t.summary || t.content.replace(/\s+/g, ' ').slice(0, 300)
      const tags = t.tags?.length ? ` [${t.tags.join(', ')}]` : ''
      ;(groups[cat] ??= []).push(`- ${t.created_at.slice(0, 10)}: ${line}${tags}`)
    }
    let material = Object.entries(groups)
      .map(([cat, lines]) => `${cat.toUpperCase()} (${lines.length})\n${lines.join('\n')}`)
      .join('\n\n')
    if (material.length > MAX_INPUT_CHARS) material = material.slice(0, MAX_INPUT_CHARS) + '\n…(trimmed)'

    // 3. Ask the AI — through the gateway, never directly
    const llmRes = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        prompt:
          `Here is everything I captured in the last 7 days (${thoughts.length} thoughts), ` +
          'grouped by category:\n\n' + material + '\n\n' +
          'Write my weekly digest with three short parts:\n' +
          '1. What you were learning this week — 3 to 5 sentences, specific.\n' +
          '2. Key themes — 3 to 5 bullet points starting with "- ".\n' +
          '3. One question you seem to be exploring — a single sentence.\n' +
          'Keep the whole thing under 300 words.',
        maxTokens: 1500,
        userId: OWNER_USER_ID,
        source: 'weekly-digest',
      }),
    })
    const llm = await llmRes.json()
    if (!llmRes.ok || !llm.text) throw new Error(`call-llm failed: ${llm.error ?? llmRes.status}`)

    // 4. Save the digest as a thought of its own
    const weekOf = since.slice(0, 10)
    const content = `🧠 Weekly digest — week of ${weekOf} (${thoughts.length} thoughts)\n\n${llm.text.trim()}`
    const { error: insertError } = await admin.from('thoughts').insert({
      user_id: OWNER_USER_ID,
      content,
      category: 'digest',
      metadata: { source: 'weekly-digest', thought_count: thoughts.length, week_of: weekOf },
    })
    if (insertError) throw insertError

    // 5. Optional: send it to you on Telegram
    let telegram = 'off'
    if (TELEGRAM_ON && BOT_TOKEN && CHAT_ID) {
      const tg = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text: content.slice(0, 4000) }),
      })
      telegram = tg.ok ? 'sent' : `failed (${tg.status})`
    }

    console.log(`[digest] saved — ${thoughts.length} thoughts, telegram ${telegram}`)
    return json({ ok: true, thoughts: thoughts.length, telegram })
  } catch (err) {
    console.error('[digest] error:', err)
    return json({ ok: false, error: String((err as Error).message ?? err) }, 500)
  }
})
