import { useState, useRef } from 'react'
import { supabase } from './lib/supabase'

type Status = 'idle' | 'uploading' | 'generating' | 'complete' | 'failed'

// Friendly translations for technical errors, so users see something
// helpful instead of raw API/network language.
function friendlyError(raw: string): string {
  const msg = raw.toLowerCase()
  if (msg.includes('network') || msg.includes('fetch')) {
    return "Couldn't reach the server. Check your connection and try again."
  }
  if (msg.includes('upload')) {
    return 'That photo could not be uploaded. Try a different image (JPG or PNG works best).'
  }
  if (msg.includes('credit') || msg.includes('billing') || msg.includes('insufficient')) {
    return 'Generation could not start — the account needs credits added.'
  }
  if (msg.includes('timeout') || msg.includes('taking longer')) {
    return 'This is taking longer than expected. Check back in a few minutes.'
  }
  if (msg.includes('invalid') && msg.includes('image')) {
    return 'That image could not be used as a reference. Try a clearer photo.'
  }
  return raw || 'Something went wrong. Please try again.'
}

// Expected generation time in seconds, used only to estimate the
// progress bar — Runway doesn't report a real percentage.
const ESTIMATED_SECONDS = 180

function App() {
  const [prompt, setPrompt] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [resolution, setResolution] = useState('720p')
  const [status, setStatus] = useState<Status>('idle')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
  }

  const handleGenerate = async () => {
    setErrorMsg(null)
    setVideoUrl(null)
    setProgress(0)

    if (!prompt.trim()) {
      setErrorMsg('Write a prompt describing the scene first.')
      return
    }
    if (!imageFile) {
      setErrorMsg('Upload a reference photo first.')
      return
    }

    try {
      setStatus('uploading')
      setProgress(5)

      const fileExt = imageFile.name.split('.').pop()
      const fileName = `${Date.now()}.${fileExt}`

      const { error: uploadError } = await supabase.storage
        .from('reference-images')
        .upload(fileName, imageFile)

      if (uploadError) {
        throw new Error('upload failed')
      }

      const { data: urlData } = supabase.storage
        .from('reference-images')
        .getPublicUrl(fileName)

      setStatus('generating')
      setProgress(10)

      const generateRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          imageUrl: urlData.publicUrl,
          resolution,
          duration: 5,
        }),
      })

      const generateData = await generateRes.json()

      if (!generateRes.ok) {
        throw new Error(generateData.error || 'Generation failed to start.')
      }

      await pollStatus(generateData.jobId)
    } catch (err: any) {
      setStatus('failed')
      setErrorMsg(friendlyError(err.message || ''))
    }
  }

  const pollStatus = async (jobId: string) => {
    const maxAttempts = 60
    const intervalMs = 5000
    let attempts = 0
    const startTime = Date.now()

    const check = async (): Promise<void> => {
      if (attempts >= maxAttempts) {
        setStatus('failed')
        setErrorMsg(friendlyError('taking longer than expected'))
        return
      }
      attempts++

      // Estimate progress from elapsed time, capped at 95% until we
      // actually hear back that it's done.
      const elapsedSeconds = (Date.now() - startTime) / 1000
      const estimated = 10 + (elapsedSeconds / ESTIMATED_SECONDS) * 85
      setProgress(Math.min(95, Math.round(estimated)))

      const res = await fetch(`/api/status?jobId=${jobId}`)
      const data = await res.json()

      if (data.status === 'complete') {
        setProgress(100)
        setVideoUrl(data.videoUrl)
        setStatus('complete')
        return
      }

      if (data.status === 'failed') {
        setStatus('failed')
        setErrorMsg(friendlyError(data.error || 'Generation failed.'))
        return
      }

      setTimeout(check, intervalMs)
    }

    await check()
  }

  const isBusy = status === 'uploading' || status === 'generating'

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1.25rem', fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>Dstudio</h1>

      <textarea
        placeholder="Describe the scene..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        style={{ width: '100%', padding: '0.75rem', fontSize: '1rem', boxSizing: 'border-box' }}
      />

      <div style={{ marginTop: '1rem' }}>
        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          onChange={handlePhotoSelect}
          style={{ display: 'none' }}
        />
