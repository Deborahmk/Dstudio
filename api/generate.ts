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
    const desc =
      action.actionType === 'dialogue'
        ? `${charName} says: "${action.description}"`
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

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { prompt, imageUrl, duration, resolution, timeline, references } = req.body

  if (!prompt || !imageUrl) {
    return res.status(400).json({ error: 'A prompt and reference image are required.' })
  }

  const ratio = resolution === '1080p' ? '1920:1080'
    : resolution === '4k' ? '3840:2160'
    : '1280:720'

  const finalPrompt = `${prompt}${buildTimelineText(timeline, references)}`.trim()

  try {
    const runwayResponse = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify({
        model: 'gen4_turbo',
        promptImage: imageUrl,
        promptText: finalPrompt,
        ratio,
        duration: duration || 5,
      }),
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
