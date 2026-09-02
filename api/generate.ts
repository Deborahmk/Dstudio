export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { prompt, imageUrl, duration, resolution } = req.body

  if (!prompt || !imageUrl) {
    return res.status(400).json({ error: 'A prompt and reference image are required.' })
  }

  const ratio = resolution === '1080p' ? '1920:1080'
    : resolution === '4k' ? '3840:2160'
    : '1280:720'

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
        promptText: prompt,
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
