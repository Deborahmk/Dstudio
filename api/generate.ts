// Turns the ordered action list into an explicit, ordered set of
// instructions appended to the scene prompt. This runs on the server
// so the timeline actually drives what gets sent to Runway, not just
// what the UI displays.
function buildTimelineText(timeline: any[], references: any[]): string {
  if (!timeline || timeline.length === 0) return ''

  const lines = timeline.map((action, idx) => {
    const num = idx + 1
    const charName = action.characterName || 'Someone'
    const timeRange =
      action.startTime || action.endTime
        ? ` (${action.startTime || '?'}s–${action.endTime || '?'}s)`
        : ''

    let relation = ''
    if (action.timingRelation && action.timingRelation !== 'none' && action.relativeToActionId) {
      const relIndex = timeline.findIndex((a: any) => a.id === action.relativeToActionId)
      if (relIndex !== -1) {
        const relLabel =
          action.timingRelation === 'before'
            ? 'before'
            : action.timingRelation === 'after'
            ? 'after'
            : 'at the same time as'
        relation = ` — happens ${relLabel} action ${relIndex + 1}`
      }
    }

    const typeLabel = String(action.actionType || 'action').toUpperCase()
    const accentNote = action.characterAccent ? ` (${action.characterAccent} accent)` : ''
    const desc =
      action.actionType === 'dialogue'
        ? `${charName}${accentNote} says: "${action.description}"`
        : `${charName} ${action.description}`

    const cam = action.cameraNote ? ` [Camera: ${action.cameraNote}]` : ''

    return `${num}. [${typeLabel}]${timeRange} ${desc}${relation}${cam}`
  })

  const charactersInScene = new Set(timeline.map((a: any) => a.characterName).filter(Boolean))
  const silentCharacters = (references || [])
    .filter((r: any) => r.type === 'character' && r.name && !charactersInScene.has(r.name))
    .map((r: any) => r.name)

  const silentLine =
    silentCharacters.length > 0
      ? `\nCharacters present in the scene but silent (no dialogue): ${silentCharacters.join(', ')}.`
      : ''

  return `\n\nFollow this exact chronological order of events. Do not move any listed action earlier than its position in this list, and respect every stated timing relationship exactly as written:\n${lines.join('\n')}${silentLine}`
}

// Maps a resolution tier + aspect ratio into the specific width:height
// pair Runway expects. These pairings are a reasonable set for each
// combination — Runway's exact supported list can change over time,
// so if a pairing is ever rejected, Runway's own error message is
// passed straight back to the person rather than failing silently.
function resolveRatio(resolution: string, aspectRatio: string): string {
  const table: Record<string, Record<string, string>> = {
    '16:9': {
      '720p': '1280:720',
      '1080p': '1920:1080',
      '4k': '3840:2160',
    },
    '9:16': {
      '720p': '720:1280',
      '1080p': '1080:1920',
      '4k': '2160:3840',
    },
    '1:1': {
      '720p': '960:960',
      '1080p': '1080:1080',
      '4k': '2160:2160',
    },
  }

  return table[aspectRatio]?.[resolution] || table['16:9']['720p']
}

// Applied to every generation, regardless of what's typed in the
// prompt box, so the visual style stays consistent across the whole
// project without anyone needing to remember to type it each time.
const STYLE_DIRECTIVE =
  'Realistic Hollywood cinematography. Natural lighting and shadows. Photorealistic architecture and environment. No artificial 3D look, no cartoon appearance, no text, no subtitles.'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { prompt, imageUrl, duration, resolution, aspectRatio, seed, timeline, references } = req.body

  if (!prompt || !imageUrl) {
    return res.status(400).json({ error: 'A prompt and reference image are required.' })
  }

  const ratio = resolveRatio(resolution, aspectRatio || '16:9')
  const finalPrompt = `${prompt}${buildTimelineText(timeline, references)}\n\n${STYLE_DIRECTIVE}`.trim()

  const requestBody: any = {
    model: 'gen4_turbo',
    promptImage: imageUrl,
    promptText: finalPrompt,
    ratio,
    duration: duration || 5,
  }

  const parsedSeed = seed !== undefined && seed !== null && seed !== '' ? parseInt(seed, 10) : null
  if (parsedSeed !== null && !isNaN(parsedSeed)) {
    requestBody.seed = parsedSeed
  }

  try {
    const runwayResponse = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify(requestBody),
    })

    const data = await runwayResponse.json()

    if (!runwayResponse.ok) {
      return res.status(runwayResponse.status).json({ error: data.error || 'Runway rejected the request.' })
    }

    return res.status(200).json({ jobId: data.id, provider: 'runway' })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach Runway. Try again in a moment.' })
  }
}
