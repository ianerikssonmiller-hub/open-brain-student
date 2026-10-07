// ============================================================================
// CAPTURE-URL
// ============================================================================
// Paste any article link and the readable text gets pulled out and saved.
//
// WHY THIS RUNS ON THE SERVER: a web browser is not allowed to fetch pages
// from other websites — that restriction is called CORS and it exists for good
// security reasons. A server has no such limit. So the app hands the link to
// this function, and this function does the fetching.
//
// For now it saves the raw article text. Summarising needs an AI key, which
// you set up in Level 5 — the enrichment step there will summarise these.
// ============================================================================

import { htmlToText } from '../_shared/html-extract.ts'
import { corsHeaders, getCaller, jsonResponse, saveCapture } from '../_shared/capture-common.ts'

const MAX_BYTES = 3_000_000 // don't try to swallow a 50MB page

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const user = await getCaller(req)
    if (!user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return jsonResponse({ ok: false, error: 'A link is required' })
    }

    // Only http(s). Blocks attempts to make the server read internal addresses.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return jsonResponse({ ok: false, error: 'That is not a valid web address' })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonResponse({ ok: false, error: 'Only http and https links are supported' })
    }

    // Fetch the page, identifying as a normal browser — some sites refuse
    // anything that looks automated.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return jsonResponse({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers. Paste the text in manually instead.`,
      })
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return jsonResponse({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab instead.`,
      })
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) {
      return jsonResponse({ ok: false, error: 'That page is too large to process' })
    }

    const { title, text } = htmlToText(raw)

    if (text.length < 200) {
      return jsonResponse({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself ' +
          'with JavaScript after loading, which a server cannot see. Paste the ' +
          'text in manually instead.',
      })
    }

    await saveCapture({
      userId: user.id,
      content: `🔗 URL: ${title}\n${parsed.toString()}\n\n${text}`,
      metadata: { source: 'url', title, url: parsed.toString(), hostname: parsed.hostname },
      sourceText: text,
      sourceKind: 'web',
    })

    return jsonResponse({ ok: true, title, hostname: parsed.hostname, chars: text.length })
  } catch (err) {
    console.error('[url] Failed:', String(err))
    const msg = String(err).includes('timeout') ? 'That page took too long to respond.' : String(err)
    return jsonResponse({ ok: false, error: msg })
  }
})
