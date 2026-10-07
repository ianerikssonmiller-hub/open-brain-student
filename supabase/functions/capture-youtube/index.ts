// ============================================================================
// CAPTURE-YOUTUBE
// ============================================================================
// Paste a YouTube link, get the spoken transcript saved into your brain.
//
// WHY THIS FILE IS COMPLICATED — worth understanding before changing anything:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a datacentre — which is exactly what a Supabase edge function is. Code
// that works perfectly on your laptop fails once deployed. That is not a bug
// in your code, it is YouTube treating servers differently from people.
//
// So we try several routes and take the first that works:
//
//   1. SUPADATA   — a service built for this. Fetches from home internet
//                   connections, so it gets real transcripts. Free tier covers
//                   ~100/month. Optional: with no key we skip to step 2.
//   2. INNERTUBE  — YouTube's own internal app API. We identify as the iPhone
//                   and Android apps, which YouTube serves properly even from
//                   a datacentre. No key needed, free, works often.
//   3. DESCRIPTION — if no captions exist anywhere (or the video has none at
//                   all), fall back to the title and description so you still
//                   capture something useful. Clearly labelled as such.
//
// For now the raw transcript is saved as-is. Summarising needs an AI key,
// which you set up in Level 5.
// ============================================================================

import { decodeEntities } from '../_shared/text.ts'
import { corsHeaders, getCaller, jsonResponse, saveCapture } from '../_shared/capture-common.ts'

const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? '' // optional

interface VideoContent {
  content: string
  hasTranscript: boolean
  source: string
}

// Pull the 11-character video id out of any YouTube URL shape
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

// Title via oEmbed — lightweight, no key, essentially always works
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return decodeEntities(data.title as string)
    }
  } catch { /* fall through to placeholder */ }
  return `Video ${videoId}`
}

// ROUTE 1 — Supadata
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(20_000) },
    )
    if (!res.ok) {
      // 402 here almost always means the free monthly quota is spent
      console.log(`[youtube] Supadata HTTP ${res.status} — falling through`)
      return null
    }
    const data = await res.json()
    const segments: Array<{ text?: string }> = data?.content ?? []
    const transcript = segments.map((s) => s.text ?? '').join(' ').replace(/\s+/g, ' ').trim()
    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: decodeEntities(transcript), hasTranscript: true, source: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// ROUTE 2 — Innertube (YouTube's internal app API)
//
// We pose as the iPhone app first, then Android. YouTube hands mobile apps a
// full caption list with signed URLs even from a datacentre, where the normal
// web page would give us nothing.
async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    // YouTube rejects app versions it considers too old ("Precondition check
    // failed"). If this route stops working, bumping these version numbers to
    // a current release of the YouTube app is usually the fix.
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      context: {
        clientName: 'IOS', clientVersion: '20.10.4',
        deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' },
    },
  ]

  // deno-lint-ignore no-explicit-any
  let best: any = null

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }
      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`)
        best = result
        break
      }
      // Keep the first response — even without captions it carries the
      // description, which is better than nothing.
      if (!best) best = result
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }

  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      const track =
        // deno-lint-ignore no-explicit-any
        tracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ??
        // deno-lint-ignore no-explicit-any
        tracks.find((t: any) => t.languageCode === 'en') ??
        // deno-lint-ignore no-explicit-any
        tracks.find((t: any) => String(t.languageCode ?? '').startsWith('en')) ??
        tracks[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })
      if (capRes.ok) {
        const xml = await capRes.text()
        // Caption XML looks like: <text start="1.2" dur="3.4">words here</text>
        const transcript = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
          // Caption text arrives escaped twice ("&amp;#39;"), so decode twice
          .map((m) => decodeEntities(decodeEntities(m[1])))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, source: 'innertube' }
        }
      }
    }

    // ROUTE 3 — no captions anywhere. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = (details?.keywords as string[] | undefined)?.join(', ') ?? ''
    if (description || keywords) {
      const content = [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n')
      console.log(`[youtube] Falling back to description — ${description.length} chars`)
      return { content, hasTranscript: false, source: 'description' }
    }
    return null
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const user = await getCaller(req)
    if (!user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return jsonResponse({ ok: false, error: 'A YouTube link is required' })
    }

    const videoId = extractVideoId(url.trim())
    if (!videoId) {
      return jsonResponse({
        ok: false,
        error: 'That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...',
      })
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    // Try each route in order, first success wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))
    if (!result) {
      return jsonResponse({
        ok: false,
        error: 'Could not read anything from that video. It may be private, age-restricted, or region-locked. Paste the transcript in manually instead.',
      })
    }

    const label = result.hasTranscript ? '' : '(No transcript was available — this is the video description)\n\n'
    await saveCapture({
      userId: user.id,
      content: `📹 YouTube: ${title}\n\n${label}${result.content}`,
      metadata: {
        source: 'youtube',
        title,
        video_id: videoId,
        video_url: videoUrl,
        has_transcript: result.hasTranscript,
        fetched_via: result.source,
      },
      sourceText: result.content,
      sourceKind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
    })

    return jsonResponse({
      ok: true,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.source,
      chars: result.content.length,
    })
  } catch (err) {
    console.error('[youtube] Failed:', String(err))
    return jsonResponse({ ok: false, error: String(err) })
  }
})
