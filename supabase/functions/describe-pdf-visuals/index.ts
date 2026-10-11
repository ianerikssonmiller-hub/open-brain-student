// ============================================================================
// DESCRIBE-PDF-VISUALS — teach your brain what's in a PDF's charts & pictures
// ============================================================================
// Text extraction (PDF.js, in your browser) only gets a PDF's words. Charts,
// diagrams, photos and tables drawn as images are lost. So for pages that
// contain visuals, your app renders the page as a picture and sends it here.
// This function asks a vision-capable AI (through your call-llm gateway) to
// describe the visuals — with the actual numbers and labels — then adds those
// descriptions to the thought and refreshes its embedding and chunks so
// search, Claude and the graph can all use them.
//
// Privacy: refuses private (🔒) thoughts outright — they never go to an AI.
//
// Request:  POST { thought_id, pages: [{ page: number, image: "data:image/jpeg;base64,..." }] }
//           (send a few pages per call; the app batches them)
// Response: { ok: true, described: number }   or   { ok: false, error }
// ============================================================================

import { admin, corsHeaders, getCaller, jsonResponse } from '../_shared/capture-common.ts'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'
import { callerAddress, securityAlert } from '../_shared/security.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const MAX_PAGES_PER_CALL = 4

const SYSTEM_PROMPT =
  'You describe the VISUAL content of document pages for a personal knowledge base, ' +
  'so it can be found later by search. Be concrete: chart type, what is measured, ' +
  'axis labels, the actual numbers and trends, table contents, diagram steps, and ' +
  'what photos show. Skip anything that is plain body text. Plain text, no markdown.'

const SECTION_HEADER = '\n\n--- Visuals (described by AI) ---'

async function internal(fn: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
    body: JSON.stringify(body),
  })
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const body = await req.json()
    const user = await getCaller(req, body)
    if (!user) {
      const address = callerAddress(req)
      await securityAlert('capture_unauthorized', { function: 'describe-pdf-visuals', address }, { dedupKey: address, windowMinutes: 60 })
      return jsonResponse({ ok: false, error: 'Not signed in' }, 401)
    }

    const pages = (Array.isArray(body.pages) ? body.pages : [])
      .filter((p: { image?: unknown }) => typeof p?.image === 'string' && p.image.startsWith('data:image/'))
      .slice(0, MAX_PAGES_PER_CALL)
    if (!body.thought_id || !pages.length) return jsonResponse({ ok: false, error: 'thought_id and pages are required' })

    // The thought must be yours — and not private
    const { data: thought } = await admin
      .from('thoughts')
      .select('id, content, user_id, is_private')
      .eq('id', body.thought_id)
      .eq('user_id', user.id)
      .single()
    if (!thought) return jsonResponse({ ok: false, error: 'Thought not found' })
    if (thought.is_private) return jsonResponse({ ok: false, error: 'Private thoughts are never sent to an AI' })

    // Ask the vision model — through the gateway, never directly
    const pageList = pages.map((p: { page: number }) => p.page).join(', ')
    const llm = await internal('call-llm', {
      systemPrompt: SYSTEM_PROMPT,
      prompt:
        `These are pages ${pageList} of a PDF, in that order. For each page that has a chart, ` +
        'graph, table, diagram, photo or other visual, write "Page N:" followed by a description ' +
        'of the visual(s) with the actual numbers and labels. If a page has no meaningful visuals, ' +
        'skip it. If none of the pages do, reply exactly: NONE',
      images: pages.map((p: { image: string }) => p.image),
      maxTokens: 2500,
      userId: user.id,
      source: 'describe-pdf-visuals',
    })
    if (!llm.text) return jsonResponse({ ok: false, error: `Vision call failed: ${llm.error ?? 'unknown'}` })

    const description = llm.text.trim()
    if (description === 'NONE') return jsonResponse({ ok: true, described: 0 })

    // Re-read (another batch may have just added its own descriptions), then append
    const { data: latest } = await admin.from('thoughts').select('content').eq('id', thought.id).single()
    const current = latest?.content ?? thought.content
    const updated = current.includes(SECTION_HEADER)
      ? `${current}\n\n${description}`
      : `${current}${SECTION_HEADER}\n${description}`

    const { error } = await admin.from('thoughts').update({ content: updated }).eq('id', thought.id)
    if (error) throw error

    // Refresh the meaning coordinates and chunks so the visuals are searchable
    const { embedding } = await internal('generate-embedding', { text: updated, userId: user.id, source: 'describe-pdf-visuals' })
    if (embedding) await admin.from('thoughts').update({ embedding }).eq('id', thought.id)
    await saveThoughtChunksSafe(admin, thought.id, updated, 'describe-pdf-visuals', 'summary', user.id)

    return jsonResponse({ ok: true, described: pages.length })
  } catch (err) {
    console.error('[describe-pdf-visuals] Failed:', String(err))
    return jsonResponse({ ok: false, error: String((err as Error).message ?? err) })
  }
})
