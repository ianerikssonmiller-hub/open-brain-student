// ============================================================================
// OPEN BRAIN MCP SERVER
// ============================================================================
// MCP (Model Context Protocol) is an open standard that lets AI assistants use
// tools. This function is an MCP server for your brain: an AI sends it a
// request like "search for marketing", this function queries your database,
// and sends the results back. The AI never touches the database itself.
//
// Every request is a small JSON message in the JSON-RPC 2.0 format:
//   { "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }
// and gets a JSON-RPC answer back with the same id.
//
// YOUR PRIVACY RULES, enforced here on the server (the AI cannot get around
// them, because it only ever sees what this code chooses to send):
//   1. Search and add only — there is no tool to delete or change anything
//   2. Short previews — never whole transcripts or documents
//   3. Thoughts marked private (is_private = true) are never returned
//
// Secrets it reads (Supabase -> Edge Functions -> Secrets):
//   MCP_ACCESS_KEY   the password your AI app must send to use this server
//   OWNER_USER_ID    your user id — whose thoughts to read and save
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deployed with --no-verify-jwt: Supabase's own login check is switched off
// because an AI app has no Supabase login. This function checks
// MCP_ACCESS_KEY itself, before doing anything else.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const MCP_ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''

// The service role key skips the Level 2 security rule, so every query below
// filters by OWNER_USER_ID and is_private by hand.
const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

const PREVIEW_CHARS = 400 // rule 2: how much of each thought the AI gets to see
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ---------------------------------------------------------------------------
// THE TOOLS — this list is everything the AI is allowed to do
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'search_thoughts',
    description:
      "Search the user's personal knowledge base (their 'Open Brain') by MEANING — " +
      'it finds related thoughts even when they use different words, plus thoughts ' +
      'linked to the top results in the brain\'s connection graph. Includes notes, voice captures, YouTube transcripts, ' +
      'PDFs, articles and Telegram messages. Returns up to 10 matches as short previews. ' +
      'Describe the topic in a few natural words (e.g. "getting new customers").',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or question to search for' },
      },
      required: ['query'],
    },
    annotations: { title: 'Search brain', readOnlyHint: true },
  },
  {
    name: 'list_recent',
    description: "List the most recent thoughts saved in the user's Open Brain, newest first, as short previews.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return (default 10, max 25)' },
      },
    },
    annotations: { title: 'Recent thoughts', readOnlyHint: true },
  },
  {
    name: 'add_thought',
    description:
      "Save a new thought to the user's Open Brain. Only use this when the user asks " +
      'you to save, remember or capture something.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text of the thought to save' },
      },
      required: ['content'],
    },
    annotations: { title: 'Save to brain', readOnlyHint: false, destructiveHint: false },
  },
]

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

// Compare passwords in constant time, so response timing leaks nothing
function safeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

// Rule 2: a short preview. Keeps the first line (usually a title like
// "📹 YouTube: ...") and, when searching, the passage around the match.
function preview(content: string, query?: string) {
  if (content.length <= PREVIEW_CHARS) return content
  const firstLine = content.split('\n')[0].slice(0, 120)
  if (query) {
    const at = content.toLowerCase().indexOf(query.toLowerCase())
    if (at > firstLine.length) {
      const start = Math.max(0, at - 150)
      const snippet = content.slice(start, start + PREVIEW_CHARS - firstLine.length)
      return `${firstLine}\n…${snippet.trim()}…`
    }
  }
  return content.slice(0, PREVIEW_CHARS).trim() + '…'
}

function formatThoughts(
  rows: { id: string; content: string; created_at: string }[],
  query?: string,
  similarities?: number[],
) {
  return rows
    .map((r, i) => {
      const score = similarities ? ` — ${Math.round(similarities[i] * 100)}% match` : ''
      return `[${r.created_at.slice(0, 10)}] (id ${r.id})${score}\n${preview(r.content, query)}`
    })
    .join('\n\n---\n\n')
}

// Hybrid results: when the match came from inside a long capture, show that
// chunk (the passage that actually matched) instead of the document's opening.
function formatHybrid(
  rows: { id: string; content: string; created_at: string; similarity: number; matched_chunk: string | null }[],
  query: string,
) {
  return rows
    .map((r) => {
      const score = r.similarity > 0 ? ` — ${Math.round(r.similarity * 100)}% meaning match` : ' — keyword match'
      const header = `[${r.created_at.slice(0, 10)}] (id ${r.id})${score}`
      if (r.matched_chunk) {
        const title = r.content.split('\n')[0].slice(0, 120)
        const chunk = r.matched_chunk.replace(/\s+/g, ' ').trim()
        const shortChunk = chunk.length > PREVIEW_CHARS ? chunk.slice(0, PREVIEW_CHARS) + '…' : chunk
        return `${header}\n${title}\n(from partway through a longer capture)\n…${shortChunk}`
      }
      return `${header}\n${preview(r.content, query)}`
    })
    .join('\n\n---\n\n')
}

// THE GRAPH — for the top results, follow their links (thought_links) and
// show the connected thoughts as short previews. Same rules as everything
// else: only your thoughts, never private ones, previews only.
async function linkedThoughts(ids: string[]): Promise<string> {
  if (!ids.length) return ''
  const list = ids.join(',')
  const { data: links } = await admin
    .from('thought_links')
    .select('source_thought_id, target_thought_id, similarity_score')
    .eq('user_id', OWNER_USER_ID)
    .or(`source_thought_id.in.(${list}),target_thought_id.in.(${list})`)
    .order('similarity_score', { ascending: false })
  if (!links?.length) return ''

  // For each result, its neighbours that aren't already in the results
  const shown = new Set(ids)
  const byResult = new Map<string, { id: string; score: number }[]>()
  for (const l of links) {
    const [from, to] = shown.has(l.source_thought_id) && !shown.has(l.target_thought_id)
      ? [l.source_thought_id, l.target_thought_id]
      : shown.has(l.target_thought_id) && !shown.has(l.source_thought_id)
        ? [l.target_thought_id, l.source_thought_id]
        : [null, null]
    if (!from || !to) continue
    const arr = byResult.get(from) ?? []
    if (arr.length < 3 && !arr.some((x) => x.id === to)) arr.push({ id: to, score: l.similarity_score })
    byResult.set(from, arr)
  }
  const neighbourIds = [...new Set([...byResult.values()].flat().map((x) => x.id))]
  if (!neighbourIds.length) return ''

  const { data: neighbours } = await admin
    .from('thoughts')
    .select('id, content')
    .in('id', neighbourIds)
    .eq('user_id', OWNER_USER_ID)
    .eq('is_private', false) // rule 3
  const contentById = new Map((neighbours ?? []).map((n) => [n.id, n.content as string]))

  const sections: string[] = []
  for (const id of ids) {
    const items = (byResult.get(id) ?? []).filter((x) => contentById.has(x.id))
    if (!items.length) continue
    const lines = items.map((x) => {
      const text = contentById.get(x.id)!.replace(/\s+/g, ' ')
      return `  ↳ ${Math.round(x.score * 100)}% linked (id ${x.id}): ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`
    })
    sections.push(`Connected to ${id}:\n${lines.join('\n')}`)
  }
  return sections.length
    ? `\n\n=== Connected thoughts (from the brain's link graph) ===\n\n${sections.join('\n\n')}`
    : ''
}

// Turn the search query into meaning coordinates via generate-embedding.
// Returns null on any failure, so search falls back to keywords.
async function embedQuery(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({ text, userId: OWNER_USER_ID, source: 'mcp-search' }),
    })
    const { embedding } = await res.json()
    return Array.isArray(embedding) ? embedding : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// WHAT EACH TOOL DOES
// ---------------------------------------------------------------------------
async function callTool(name: string, args: Record<string, unknown>) {
  if (name === 'search_thoughts') {
    const query = String(args.query ?? '').trim()
    if (!query) return toolText('Please provide something to search for.', true)

    // 1. Hybrid search: meaning AND exact keywords, fused into one ranking,
    //    and long captures matched by their best chunk. p_user_id is required:
    //    this server uses the service role key, which skips row-level
    //    security, so it must say whose thoughts to search. Private thoughts
    //    are excluded (p_include_private defaults to false) — rule 3.
    //    If the embedding fails, search still runs on keywords alone.
    const embedding = await embedQuery(query)
    const { data, error } = await admin.rpc('search_thoughts', {
      query_text: query,
      p_user_id: OWNER_USER_ID,
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 10,
      max_per_document: 2,
    })
    if (error) throw error
    if (data?.length) {
      const lines = formatHybrid(data, query)
      const linked = await linkedThoughts(data.slice(0, 5).map((r: { id: string }) => r.id))
      return toolText(`${data.length} thought(s) found for "${query}" (meaning + keywords):\n\n${lines}${linked}`)
    }

    // 2. Fallback: exact keyword search (if embedding failed or nothing was close)
    // % and _ are wildcards in ilike — escape them so they match literally
    const escaped = query.replace(/[\\%_]/g, (c) => '\\' + c)
    const { data: kwData, error: kwError } = await admin
      .from('thoughts')
      .select('id, content, created_at')
      .eq('user_id', OWNER_USER_ID)
      .eq('is_private', false) // rule 3
      .ilike('content', `%${escaped}%`)
      .order('created_at', { ascending: false })
      .limit(10)
    if (kwError) throw kwError
    if (!kwData?.length) return toolText(`No thoughts match "${query}".`)
    return toolText(`${kwData.length} thought(s) containing "${query}":\n\n${formatThoughts(kwData, query)}`)
  }

  if (name === 'list_recent') {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25)
    const { data, error } = await admin
      .from('thoughts')
      .select('id, content, created_at')
      .eq('user_id', OWNER_USER_ID)
      .eq('is_private', false) // rule 3
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    if (!data?.length) return toolText('The brain is empty so far.')
    return toolText(`${data.length} most recent thought(s):\n\n${formatThoughts(data)}`)
  }

  if (name === 'add_thought') {
    const content = String(args.content ?? '').trim()
    if (!content) return toolText('Nothing to save — content was empty.', true)
    const { data, error } = await admin
      .from('thoughts')
      // upsert: saving the exact same text twice updates instead of duplicating
      .upsert({ content, user_id: OWNER_USER_ID, metadata: { source: 'mcp' } }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
      .select('id, created_at')
      .single()
    if (error) throw error
    return toolText(`Saved to the brain (id ${data.id}).`)
  }

  return toolText(`Unknown tool: ${name}`, true)
}

function toolText(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

// ---------------------------------------------------------------------------
// JSON-RPC: route one message to the right handler
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleMessage(msg: any) {
  const { id, method, params } = msg ?? {}
  const isNotification = id === undefined || id === null
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  // Notifications (like "initialized") expect no answer
  if (isNotification) return null

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        return ok({
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'open-brain', version: '1.0.0' },
          instructions:
            "This server is the user's personal knowledge base. Search it when the user " +
            'refers to things they saved, learned, watched or read.',
        })
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: TOOLS })
      case 'tools/call':
        return ok(await callTool(params?.name, params?.arguments ?? {}))
      default:
        return fail(-32601, `Method not found: ${method}`)
    }
  } catch (err) {
    console.error('open-brain-mcp error:', err)
    // Tool failures go back as a readable tool error rather than a crash
    if (method === 'tools/call') return ok(toolText(`Error: ${(err as Error).message ?? err}`, true))
    return fail(-32603, 'Internal error')
  }
}

// ---------------------------------------------------------------------------
// THE DOOR — every request comes through here
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  // This server answers plain POST requests only (no streaming)
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })

  // Check the password before anything else
  if (!MCP_ACCESS_KEY || !OWNER_USER_ID) {
    return json({ error: 'Server not configured: MCP_ACCESS_KEY or OWNER_USER_ID secret is missing' }, 500)
  }
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!safeEqual(token, MCP_ACCESS_KEY)) return json({ error: 'Unauthorized' }, 401)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }

  // A request can be one message or a batch (array) of messages
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handleMessage))).filter(Boolean)
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: corsHeaders })
  }
  const reply = await handleMessage(body)
  return reply ? json(reply) : new Response(null, { status: 202, headers: corsHeaders })
})
