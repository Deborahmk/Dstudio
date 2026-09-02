import { useState, useRef } from 'react'
import { supabase } from './lib/supabase'

type Status = 'idle' | 'uploading' | 'generating' | 'complete' | 'failed'

function App() {
  const [prompt, setPrompt] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [resolution, setResolution] = useState('720p')
  const [status, setStatus] = useState<Status>('idle')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
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

      const fileExt = imageFile.name.split('.').pop()
      const fileName = `${Date.now()}.${fileExt}`

      const { error: uploadError } = await supabase.storage
        .from('reference-images')
        .upload(fileName, imageFile)

      if (uploadError) {
        throw new Error('Could not upload the photo. Try again.')
      }

      const { data: urlData } = supabase.storage
        .from('reference-images')
        .getPublicUrl(fileName)

      setStatus('generating')

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
      setErrorMsg(err.message || 'Something went wrong.')
    }
  }

  const pollStatus = async (jobId: string) => {
    const maxAttempts = 60
    let attempts = 0

    const check = async (): Promise<void> => {
      if (attempts >= maxAttempts) {
        setStatus('failed')
        setErrorMsg('This is taking longer than expected. Check back in a bit.')
        return
      }
      attempts++

      const res = await fetch(`/api/status?jobId=${jobId}`)
      const data = await res.json()

      if (data.status === 'complete') {
        setVideoUrl(data.videoUrl)
        setStatus('complete')
        return
      }

      if (data.status === 'failed') {
        setStatus('failed')
        setErrorMsg(data.error || 'Generation failed.')
        return
      }

      setTimeout(check, 5000)
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
        <button onClick={() => fileInputRef.current?.click()} style={{ padding: '0.6rem 1rem' }}>
          {imageFile ? 'Change reference photo' : 'Upload reference photo'}
        </button>
        {imagePreview && (
          <img src={imagePreview} alt="reference" style={{ width: '100%', marginTop: '0.75rem', borderRadius: 8 }} />
        )}
      </div>

      <div style={{ marginTop: '1rem' }}>
        <label>Resolution: </label>
        <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="4k">4K</option>
        </select>
      </div>

      <button
        onClick={handleGenerate}
        disabled={isBusy}
        style={{ marginTop: '1.25rem', padding: '0.8rem 1.5rem', fontSize: '1rem', width: '100%' }}
      >
        {status === 'uploading' && 'Uploading photo...'}
        {status === 'generating' && 'Generating...'}
        {(status === 'idle' || status === 'complete' || status === 'failed') && 'Generate'}
      </button>

      {errorMsg && <p style={{ color: 'crimson', marginTop: '1rem' }}>{errorMsg}</p>}

      {videoUrl && (
        <div style={{ marginTop: '1.5rem' }}>
          <video src={videoUrl} controls style={{ width: '100%', borderRadius: 8 }} />
          <a href={videoUrl} download style={{ display: 'block', marginTop: '0.75rem', textAlign: 'center' }}>
            Download video
          </a>
        </div>
      )}
    </div>
  )
}

export default App
