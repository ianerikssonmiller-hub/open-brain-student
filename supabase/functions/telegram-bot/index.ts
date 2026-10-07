// Telegram bot for your Open Brain.
//
// How it works: Telegram sends every message your bot receives to this
// function (that's the "webhook"). The function decides what to do with it:
//   /search <words>  or  ? <words>  -> search your thoughts, reply with top 5
//   /recent                          -> reply with your last 5 thoughts
//   /start                           -> say hello
//   /private <text>                  -> save it as a PRIVATE thought
//   anything else                    -> save it as a new thought
//
// Private thoughts never come back in /search or /recent here — they are kept
// out of every outside service that reads your brain (this bot, and Claude
// from Level 4). Note: Telegram itself still sees what you type to the bot.
//
// Secrets it reads (set in Supabase -> Edge Functions -> Secrets):
//   TELEGRAM_BOT_TOKEN   your bot's password from BotFather
//   OWNER_USER_ID        your Supabase user id, so saved thoughts belong to you
//   TELEGRAM_CHAT_ID     your personal Telegram chat id, so ONLY you can use the bot
// Provided automatically by Supabase (you never set these):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

// The service role key skips the Level 2 security rule entirely. That is why
// every query below filters by OWNER_USER_ID by hand — nothing else will.
const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Always answer Telegram with 200, even on errors. Anything else makes
// Telegram retry the same message over and over.
function ok() {
  return new Response('ok', { status: 200, headers: corsHeaders })
}

async function reply(chatId: number, text: string) {
  // Telegram rejects messages over 4096 characters.
  const safe = text.length > 4000 ? text.slice(0, 4000) + '…' : text
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: safe }),
  })
}

function formatThoughts(rows: { content: string; created_at: string }[]) {
  return rows
    .map((r, i) => {
      const date = new Date(r.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      const preview = r.content.length > 300 ? r.content.slice(0, 300) + '…' : r.content
      return `${i + 1}. ${preview}\n   — ${date}`
    })
    .join('\n\n')
}

async function searchThoughts(chatId: number, query: string) {
  if (!query) {
    await reply(chatId, 'What should I search for? Try: /search grill')
    return
  }
  // % and _ are wildcards in ilike — escape them so they match literally.
  const escaped = query.replace(/[\\%_]/g, (c) => '\\' + c)
  const { data, error } = await admin
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .eq('is_private', false)
    .ilike('content', `%${escaped}%`)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  if (!data || data.length === 0) {
    await reply(chatId, `Nothing in your brain matches "${query}".`)
    return
  }
  await reply(chatId, `🔎 Results for "${query}":\n\n${formatThoughts(data)}`)
}

async function recentThoughts(chatId: number) {
  const { data, error } = await admin
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .eq('is_private', false)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  if (!data || data.length === 0) {
    await reply(chatId, 'Your brain is empty so far. Send me a thought!')
    return
  }
  await reply(chatId, `🕒 Your last ${data.length} thoughts:\n\n${formatThoughts(data)}`)
}

async function saveThought(chatId: number, text: string, isPrivate = false) {
  if (!text) {
    await reply(chatId, 'Nothing to save. Try: /private my note here')
    return
  }
  const { error } = await admin.from('thoughts').insert({
    content: text,
    user_id: OWNER_USER_ID,
    is_private: isPrivate,
    metadata: { source: 'telegram' },
  })
  if (error) throw error
  await reply(chatId, isPrivate ? '🔒 Saved privately to your brain' : '🧠 Saved to your brain')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  let chatId: number | undefined
  try {
    const update = await req.json()
    const message = update.message ?? update.edited_message
    const text: string | undefined = message?.text?.trim()
    chatId = message?.chat?.id
    if (!chatId || !text) return ok() // photos, stickers, etc. — ignore for now

    // The door is open (--no-verify-jwt), so the function checks who is
    // knocking itself. Until TELEGRAM_CHAT_ID is set, the bot only tells you
    // your chat id and does nothing else.
    if (!ALLOWED_CHAT_ID) {
      await reply(
        chatId,
        `Almost ready! Your chat ID is ${chatId}\n\nAdd it in Supabase as a secret named TELEGRAM_CHAT_ID, then send me a message again.`,
      )
      return ok()
    }
    if (String(chatId) !== ALLOWED_CHAT_ID) return ok() // a stranger — stay silent

    if (!OWNER_USER_ID) {
      await reply(chatId, 'Setup problem: the OWNER_USER_ID secret is missing in Supabase.')
      return ok()
    }

    const lower = text.toLowerCase()
    if (lower === '/start') {
      await reply(
        chatId,
        "👋 I'm your Open Brain.\n\n• Send any message and I'll save it\n• /private <text> to save it privately\n• /search <words> (or ? <words>) to search\n• /recent to see your last 5 thoughts",
      )
    } else if (lower.startsWith('/search')) {
      await searchThoughts(chatId, text.slice('/search'.length).trim())
    } else if (text.startsWith('?')) {
      await searchThoughts(chatId, text.slice(1).trim())
    } else if (lower.startsWith('/recent')) {
      await recentThoughts(chatId)
    } else if (lower.startsWith('/private')) {
      await saveThought(chatId, text.slice('/private'.length).trim(), true)
    } else {
      await saveThought(chatId, text)
    }
  } catch (err) {
    console.error('telegram-bot error:', err)
    if (chatId) {
      try {
        await reply(chatId, '⚠️ Something went wrong. Check the function logs in Supabase.')
      } catch { /* nothing more we can do */ }
    }
  }
  return ok()
})
