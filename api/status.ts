export default async function handler(req: any, res: any) {
  const { jobId } = req.query

  if (!jobId) {
    return res.status(400).json({ error: 'Missing job ID.' })
  }

  try {
    const runwayResponse = await fetch(`https://api.dev.runwayml.com/v1/tasks/${jobId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
        'X-Runway-Version': '2024-11-06',
      },
    })

    const data = await runwayResponse.json()

    if (!runwayResponse.ok) {
      return res.status(runwayResponse.status).json({ error: data.error || 'Could not check status.' })
    }

    if (data.status === 'SUCCEEDED') {
      return res.status(200).json({ status: 'complete', videoUrl: data.output[0] })
    }

    if (data.status === 'FAILED') {
      return res.status(200).json({ status: 'failed', error: data.failure || 'Generation failed.' })
    }

    return res.status(200).json({ status: 'processing' })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reach Runway.' })
  }
}
