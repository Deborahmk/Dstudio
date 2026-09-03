import { useState, useRef, useEffect } from 'react'
import { supabase } from './lib/supabase'

type Status = 'idle' | 'uploading' | 'generating' | 'complete' | 'failed'
type ReferenceType = 'character' | 'environment'
type ActionType = 'action' | 'dialogue' | 'reaction' | 'pause'
type TimingRelation = 'none' | 'before' | 'after' | 'same_time'

type TimelineAction = {
  id: string
  characterId: string | null
  characterName: string
  description: string
  startTime: string
  endTime: string
  actionType: ActionType
  timingRelation: TimingRelation
  relativeToActionId: string | null
  cameraNote: string
}

type Reference = {
  id: string
  name: string
  type: ReferenceType
  identityLocked: boolean
  previewUrl: string
  uploadedUrl: string | null
  uploading: boolean
}

type Generation = {
  id: number
  created_at: string
  prompt: string
  image_url: string
  video_url: string
  resolution: string
  timeline: TimelineAction[] | null
  aspect_ratio: string | null
  seed: string | null
}

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

// Short example prompts to tap and try. Kept in Runway's sweet spot:
// a subject, an action, and a bit of camera/mood detail.
const EXAMPLE_PROMPTS = [
  'Slow push-in on her face as she smiles, warm kitchen light',
  'She walks across a school hallway, students blurred behind her',
  'Close-up over the chessboard, hands moving a piece, tense mood',
  'Wide shot of a coffee shop, steam rising, soft afternoon light',
]

const PROMPT_SOFT_LIMIT = 500

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function App() {
  const [prompt, setPrompt] = useState('')
  const [resolution, setResolution] = useState('720p')
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [duration, setDuration] = useState('5')
  const [seed, setSeed] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [history, setHistory] = useState<Generation[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [references, setReferences] = useState<Reference[]>([])
  const [activeReferenceId, setActiveReferenceId] = useState<string | null>(null)
  const referenceInputRef = useRef<HTMLInputElement>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [timeline, setTimeline] = useState<TimelineAction[]>([])
  const [pendingConfirm, setPendingConfirm] = useState(false)

  // Load past generations once when the app first opens.
  useEffect(() => {
    loadHistory()
  }, [])

  const loadHistory = async () => {
    setHistoryLoading(true)
    const { data, error } = await supabase
      .from('generations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)

    if (!error && data) {
      setHistory(data as Generation[])
    }
    setHistoryLoading(false)
  }

  const saveToHistory = async (finishedVideoUrl: string, referenceImageUrl: string) => {
    await supabase.from('generations').insert({
      prompt,
      image_url: referenceImageUrl,
      video_url: finishedVideoUrl,
      resolution,
      timeline: timeline.length > 0 ? timeline : null,
      aspect_ratio: aspectRatio,
      seed: seed.trim() || null,
    })
    // Refresh the list so the new video shows up right away.
    loadHistory()
  }

  // Restores a past generation's prompt, resolution, aspect ratio,
  // seed, and full timeline back into the form, so Regenerate picks
  // up exactly where that generation left off.
  const handleRegenerate = (item: Generation) => {
    setPrompt(item.prompt)
    setResolution(item.resolution)
    setAspectRatio(item.aspect_ratio || '16:9')
    setSeed(item.seed || '')
    setTimeline(item.timeline || [])
    if (item.timeline && item.timeline.length > 0) {
      setShowAdvanced(true)
    }
    setErrorMsg(null)
    setVideoUrl(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Adding references: each selected photo becomes its own card right
  // away (with a local preview), while the actual upload to Supabase
  // Storage happens in the background so the UI never feels frozen.
  const handleAddReferences = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    Array.from(files).forEach((file) => {
      const id = makeId()
      const previewUrl = URL.createObjectURL(file)

      setReferences((prev) => [
        ...prev,
        {
          id,
          name: '',
          type: 'character',
          identityLocked: true,
          previewUrl,
          uploadedUrl: null,
          uploading: true,
        },
      ])

      uploadReferenceFile(id, file)
    })

    // Reset so selecting the same file again still fires onChange.
    e.target.value = ''
  }

  const uploadReferenceFile = async (id: string, file: File) => {
    try {
      const fileExt = file.name.split('.').pop()
      const fileName = `ref-${id}.${fileExt}`

      const { error: uploadError } = await supabase.storage
        .from('reference-images')
        .upload(fileName, file)

      if (uploadError) {
        throw new Error('upload failed')
      }

      const { data: urlData } = supabase.storage
        .from('reference-images')
        .getPublicUrl(fileName)

      setReferences((prev) =>
        prev.map((r) => (r.id === id ? { ...r, uploadedUrl: urlData.publicUrl, uploading: false } : r))
      )

      // Auto-select the first reference that finishes uploading, so
      // there's always something ready to generate with.
      setActiveReferenceId((current) => current ?? id)
    } catch {
      setReferences((prev) => prev.map((r) => (r.id === id ? { ...r, uploading: false } : r)))
      setErrorMsg(friendlyError('upload failed'))
    }
  }

  const updateReference = (id: string, patch: Partial<Reference>) => {
    setReferences((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const removeReference = (id: string) => {
    setReferences((prev) => prev.filter((r) => r.id !== id))
    if (activeReferenceId === id) {
      setActiveReferenceId(null)
    }
  }

  const activeReference = references.find((r) => r.id === activeReferenceId) || null

  const addAction = () => {
    setPendingConfirm(false)
    setTimeline((prev) => [
      ...prev,
      {
        id: makeId(),
        characterId: null,
        characterName: '',
        description: '',
        startTime: '',
        endTime: '',
        actionType: 'action',
        timingRelation: 'none',
        relativeToActionId: null,
        cameraNote: '',
      },
    ])
  }

  const updateAction = (id: string, patch: Partial<TimelineAction>) => {
    setPendingConfirm(false)
    setTimeline((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  const removeAction = (id: string) => {
    setPendingConfirm(false)
    setTimeline((prev) =>
      prev
        .filter((a) => a.id !== id)
        .map((a) => (a.relativeToActionId === id ? { ...a, relativeToActionId: null, timingRelation: 'none' } : a))
    )
  }

  const moveAction = (id: string, direction: 'up' | 'down') => {
    setPendingConfirm(false)
    setTimeline((prev) => {
      const index = prev.findIndex((a) => a.id === id)
      const swapWith = direction === 'up' ? index - 1 : index + 1
      if (index === -1 || swapWith < 0 || swapWith >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[swapWith]] = [next[swapWith], next[index]]
      return next
    })
  }

  // Rough estimate of how much time the timeline actually needs, used
  // only to warn the person before generating — dialogue is estimated
  // by reading speed, other actions get a flat couple of seconds each,
  // unless explicit start/end times were given, which take priority.
  const estimateNeededSeconds = (): number => {
    let maxEnd = 0
    let hasExplicitTimes = false
    let heuristicTotal = 0

    timeline.forEach((a) => {
      const end = parseFloat(a.endTime)
      if (!isNaN(end)) {
        hasExplicitTimes = true
        maxEnd = Math.max(maxEnd, end)
      }
      if (a.actionType === 'dialogue') {
        heuristicTotal += Math.max(1, a.description.length / 14)
      } else if (a.actionType === 'pause') {
        heuristicTotal += 1.5
      } else {
        heuristicTotal += 2
      }
    })

    return hasExplicitTimes ? maxEnd : heuristicTotal
  }

  const estimatedSeconds = estimateNeededSeconds()
  const durationNum = parseInt(duration, 10)
  const showDurationWarning = timeline.length > 0 && estimatedSeconds > durationNum

  const handleGenerate = async () => {
    setErrorMsg(null)
    setVideoUrl(null)
    setProgress(0)

    if (!prompt.trim()) {
      setErrorMsg('Write a prompt describing the scene first.')
      return
    }
    if (!activeReference) {
      setErrorMsg('Add and select a reference photo first.')
      return
    }
    if (activeReference.uploading || !activeReference.uploadedUrl) {
      setErrorMsg('That reference photo is still uploading. Wait a moment and try again.')
      return
    }
    if (showDurationWarning && !pendingConfirm) {
      setPendingConfirm(true)
      setErrorMsg(
        `This scene looks like more than fits in ${duration}s. Consider splitting it into multiple clips, or tap Generate again to proceed anyway.`
      )
      return
    }
    setPendingConfirm(false)

    // If the selected reference has Identity Lock on, weave its name
    // into the prompt automatically — this is the same "repeat the
    // character's details every time" trick that helps keep faces
    // consistent across separate generations, just done for you.
    const finalPrompt =
      activeReference.identityLocked && activeReference.name.trim()
        ? `${activeReference.name.trim()}: ${prompt.trim()}`
        : prompt.trim()

    try {
      setStatus('generating')
      setProgress(10)

      const generateRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: finalPrompt,
          imageUrl: activeReference.uploadedUrl,
          resolution,
          aspectRatio,
          duration: durationNum,
          seed: seed.trim() || undefined,
          timeline,
          references: references.map((r) => ({ name: r.name, type: r.type })),
        }),
      })

      const generateData = await generateRes.json()

      if (!generateRes.ok) {
        throw new Error(generateData.error || 'Generation failed to start.')
      }

      await pollStatus(generateData.jobId, activeReference.uploadedUrl)
    } catch (err: any) {
      setStatus('failed')
      setErrorMsg(friendlyError(err.message || ''))
    }
  }

  const pollStatus = async (jobId: string, referenceImageUrl: string) => {
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
        await saveToHistory(data.videoUrl, referenceImageUrl)
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
  const promptLength = prompt.length
  const overSoftLimit = promptLength > PROMPT_SOFT_LIMIT

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '1.5rem 1rem 3rem', fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1.25rem' }}>Dstudio</h1>

      <textarea
        placeholder="Describe the scene..."
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        style={{
          width: '100%',
          padding: '0.75rem',
          fontSize: '16px',
          boxSizing: 'border-box',
          borderRadius: 8,
          border: '1px solid #ccc',
        }}
      />

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          fontSize: '0.75rem',
          color: overSoftLimit ? '#d32f2f' : '#999',
          marginTop: '0.25rem',
        }}
      >
        {promptLength} characters{overSoftLimit ? ' — consider trimming for best results' : ''}
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}>Need ideas? Tap one to try it:</p>
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            overflowX: 'auto',
            paddingBottom: '0.25rem',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {EXAMPLE_PROMPTS.map((example, i) => (
            <button
              key={i}
              onClick={() => setPrompt(example)}
              style={{
                flexShrink: 0,
                whiteSpace: 'nowrap',
                fontSize: '0.8rem',
                padding: '0.5rem 0.9rem',
                borderRadius: 20,
                border: '1px solid #ddd',
                background: '#f7f7f7',
                minHeight: 36,
              }}
            >
              {example.length > 40 ? example.slice(0, 40) + '…' : example}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
          <h2 style={{ fontSize: '1rem', margin: 0 }}>References</h2>
          <span style={{ fontSize: '0.75rem', color: '#999' }}>Tap a card to select it</span>
        </div>

        <input
          type="file"
          accept="image/*"
          multiple
          ref={referenceInputRef}
          onChange={handleAddReferences}
          style={{ display: 'none' }}
        />
        <button
          onClick={() => referenceInputRef.current?.click()}
          style={{ padding: '0.75rem 1.1rem', minHeight: 48, fontSize: '1rem', borderRadius: 8, width: '100%', border: '1px dashed #aaa', background: '#fafafa' }}
        >
          + Add reference photo
        </button>

        {references.length === 0 && (
          <p style={{ fontSize: '0.85rem', color: '#999', marginTop: '0.75rem' }}>
            Add a photo for each character and location you'll use. Runway will only see the one you select below when you generate.
          </p>
        )}

        {references.map((ref) => {
          const isActive = ref.id === activeReferenceId
          return (
            <div
              key={ref.id}
              onClick={() => !ref.uploading && setActiveReferenceId(ref.id)}
              style={{
                display: 'flex',
                gap: '0.75rem',
                marginTop: '0.75rem',
                padding: '0.75rem',
                borderRadius: 10,
                border: isActive ? '2px solid #4f46e5' : '1px solid #ddd',
                background: isActive ? '#f5f4ff' : '#fff',
                opacity: ref.uploading ? 0.6 : 1,
              }}
            >
              <img
                src={ref.previewUrl}
                alt={ref.name || 'reference'}
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }}
              />

              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  type="text"
                  placeholder="Name (e.g. Thandie)"
                  value={ref.name}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateReference(ref.id, { name: e.target.value })}
                  style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc', boxSizing: 'border-box' }}
                />

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={ref.type}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updateReference(ref.id, { type: e.target.value as ReferenceType })}
                    style={{ padding: '0.35rem 0.5rem', fontSize: '0.85rem', borderRadius: 6, border: '1px solid #ccc' }}
                  >
                    <option value="character">Character</option>
                    <option value="environment">Environment</option>
                  </select>

                  <label
                    onClick={(e) => e.stopPropagation()}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: '#555' }}
                  >
                    <input
                      type="checkbox"
                      checked={ref.identityLocked}
                      onChange={(e) => updateReference(ref.id, { identityLocked: e.target.checked })}
                    />
                    {ref.type === 'environment' ? 'Environment locked' : 'Identity locked'}
                  </label>
                </div>

                <p style={{ fontSize: '0.75rem', color: '#999', marginTop: '0.4rem', marginBottom: 0 }}>
                  {ref.uploading ? 'Uploading...' : isActive ? 'Selected for this generation' : 'Tap to select'}
                </p>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removeReference(ref.id)
                }}
                style={{ alignSelf: 'flex-start', border: 'none', background: 'none', color: '#999', fontSize: '1.1rem', padding: '0.25rem', minWidth: 32, minHeight: 32 }}
                aria-label="Remove reference"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <button
          onClick={() => setShowAdvanced((s) => !s)}
          style={{
            width: '100%',
            textAlign: 'left',
            padding: '0.75rem 1rem',
            minHeight: 48,
            borderRadius: 8,
            border: '1px solid #ddd',
            background: '#fafafa',
            fontSize: '0.95rem',
            fontWeight: 600,
          }}
        >
          {showAdvanced ? '▾' : '▸'} Advanced Controls
        </button>

        {showAdvanced && (
          <div style={{ marginTop: '0.75rem', padding: '0.75rem', border: '1px solid #eee', borderRadius: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
              <h2 style={{ fontSize: '1rem', margin: 0 }}>Actions and Timing</h2>
            </div>

            {timeline.length === 0 && (
              <p style={{ fontSize: '0.85rem', color: '#999', marginBottom: '0.75rem' }}>
                Add each thing that happens in the scene, in order. Dialogue, reactions, and pauses can all be timed and linked to each other.
              </p>
            )}

            {timeline.map((action, index) => {
              const priorActions = timeline.filter((a) => a.id !== action.id)
              return (
                <div
                  key={action.id}
                  style={{ padding: '0.75rem', marginBottom: '0.75rem', borderRadius: 10, border: '1px solid #ddd', background: '#fff' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>#{index + 1}</span>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button
                        onClick={() => moveAction(action.id, 'up')}
                        disabled={index === 0}
                        style={{ minWidth: 32, minHeight: 32, borderRadius: 6, border: '1px solid #ddd', background: '#fff', opacity: index === 0 ? 0.4 : 1 }}
                        aria-label="Move up"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveAction(action.id, 'down')}
                        disabled={index === timeline.length - 1}
                        style={{ minWidth: 32, minHeight: 32, borderRadius: 6, border: '1px solid #ddd', background: '#fff', opacity: index === timeline.length - 1 ? 0.4 : 1 }}
                        aria-label="Move down"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => removeAction(action.id)}
                        style={{ minWidth: 32, minHeight: 32, borderRadius: 6, border: '1px solid #ddd', background: '#fff', color: '#c00' }}
                        aria-label="Delete action"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>Character</label>
                  <select
                    value={action.characterId ?? '__other__'}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val === '__other__') {
                        updateAction(action.id, { characterId: null })
                      } else {
                        const ref = references.find((r) => r.id === val)
                        updateAction(action.id, { characterId: val, characterName: ref?.name || '' })
                      }
                    }}
                    style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc', marginBottom: '0.5rem' }}
                  >
                    <option value="__other__">Other / type name</option>
                    {references
                      .filter((r) => r.type === 'character')
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name || 'Unnamed'}
                        </option>
                      ))}
                  </select>

                  {action.characterId === null && (
                    <input
                      type="text"
                      placeholder="Character name"
                      value={action.characterName}
                      onChange={(e) => updateAction(action.id, { characterName: e.target.value })}
                      style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc', marginBottom: '0.5rem', boxSizing: 'border-box' }}
                    />
                  )}

                  <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>
                    {action.actionType === 'dialogue' ? 'Line of dialogue' : 'Action description'}
                  </label>
                  <textarea
                    value={action.description}
                    onChange={(e) => updateAction(action.id, { description: e.target.value })}
                    rows={2}
                    style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc', marginBottom: '0.5rem', boxSizing: 'border-box' }}
                  />

                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>Start (sec)</label>
                      <input
                        type="number"
                        value={action.startTime}
                        onChange={(e) => updateAction(action.id, { startTime: e.target.value })}
                        style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>End (sec)</label>
                      <input
                        type="number"
                        value={action.endTime}
                        onChange={(e) => updateAction(action.id, { endTime: e.target.value })}
                        style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc', boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>Type</label>
                      <select
                        value={action.actionType}
                        onChange={(e) => updateAction(action.id, { actionType: e.target.value as ActionType })}
                        style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc' }}
                      >
                        <option value="action">Action</option>
                        <option value="dialogue">Dialogue</option>
                        <option value="reaction">Reaction</option>
                        <option value="pause">Pause</option>
                      </select>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>Timing</label>
                      <select
                        value={action.timingRelation}
                        onChange={(e) => updateAction(action.id, { timingRelation: e.target.value as TimingRelation })}
                        style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc' }}
                      >
                        <option value="none">No relation</option>
                        <option value="before">Before</option>
                        <option value="after">After</option>
                        <option value="same_time">At the same time as</option>
                      </select>
                    </div>
                    {action.timingRelation !== 'none' && (
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>Relative to</label>
                        <select
                          value={action.relativeToActionId ?? ''}
                          onChange={(e) => updateAction(action.id, { relativeToActionId: e.target.value || null })}
                          style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc' }}
                        >
                          <option value="">Select action</option>
                          {priorActions.map((a) => {
                            const otherIndex = timeline.findIndex((t) => t.id === a.id)
                            return (
                              <option key={a.id} value={a.id}>
                                #{otherIndex + 1} {a.description.slice(0, 20)}
                              </option>
                            )
                          })}
                        </select>
                      </div>
                    )}
                  </div>

                  <label style={{ display: 'block', fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>Camera note (optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. cut to close-up"
                    value={action.cameraNote}
                    onChange={(e) => updateAction(action.id, { cameraNote: e.target.value })}
                    style={{ width: '100%', padding: '0.5rem', fontSize: '16px', borderRadius: 6, border: '1px solid #ccc', boxSizing: 'border-box' }}
                  />
                </div>
              )
            })}

            <button
              onClick={addAction}
              style={{ padding: '0.7rem 1rem', minHeight: 48, fontSize: '0.95rem', borderRadius: 8, width: '100%', border: '1px dashed #aaa', background: '#fafafa' }}
            >
              + Add Action
            </button>

            {showDurationWarning && (
              <p style={{ fontSize: '0.8rem', color: '#d32f2f', marginTop: '0.75rem' }}>
                This scene looks like it needs roughly {Math.round(estimatedSeconds)}s, longer than the {duration}s clip you've selected. Consider splitting it into multiple clips.
              </p>
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: '1.25rem' }}>
        <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }}>Resolution</label>
        <select
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          style={{ width: '100%', padding: '0.7rem', fontSize: '16px', minHeight: 48, borderRadius: 8 }}
        >
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="4k">4K</option>
        </select>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }}>Aspect ratio</label>
        <select
          value={aspectRatio}
          onChange={(e) => setAspectRatio(e.target.value)}
          style={{ width: '100%', padding: '0.7rem', fontSize: '16px', minHeight: 48, borderRadius: 8 }}
        >
          <option value="16:9">16:9 (widescreen / cinematic)</option>
          <option value="9:16">9:16 (vertical / mobile)</option>
          <option value="1:1">1:1 (square)</option>
        </select>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }}>Duration</label>
        <select
          value={duration}
          onChange={(e) => {
            setPendingConfirm(false)
            setDuration(e.target.value)
          }}
          style={{ width: '100%', padding: '0.7rem', fontSize: '16px', minHeight: 48, borderRadius: 8 }}
        >
          <option value="5">5 seconds</option>
          <option value="10">10 seconds</option>
        </select>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem' }}>Seed (optional)</label>
        <input
          type="text"
          inputMode="numeric"
          placeholder="Leave blank for random"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          style={{ width: '100%', padding: '0.7rem', fontSize: '16px', minHeight: 48, borderRadius: 8, border: '1px solid #ccc', boxSizing: 'border-box' }}
        />
        <p style={{ fontSize: '0.75rem', color: '#999', marginTop: '0.3rem' }}>
          Reusing the same seed with the same prompt and reference can produce a more similar result — useful for small retries.
        </p>
      </div>

      <button
        onClick={handleGenerate}
        disabled={isBusy}
        style={{
          marginTop: '1.5rem',
          padding: '0.9rem 1.5rem',
          fontSize: '1.05rem',
          width: '100%',
          minHeight: 52,
          borderRadius: 8,
          fontWeight: 600,
        }}
      >
        {status === 'uploading' && 'Uploading photo...'}
        {status === 'generating' && 'Generating...'}
        {(status === 'idle' || status === 'complete' || status === 'failed') && 'Generate'}
      </button>

      {isBusy && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ width: '100%', height: 10, background: '#eee', borderRadius: 6, overflow: 'hidden' }}>
            <div
              style={{
                width: `${progress}%`,
                height: '100%',
                background: '#4f46e5',
                transition: 'width 0.4s ease',
              }}
            />
          </div>
          <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.4rem', textAlign: 'center' }}>
            {progress}%
          </p>
        </div>
      )}

      {errorMsg && <p style={{ color: 'crimson', marginTop: '1rem' }}>{errorMsg}</p>}

      {videoUrl && (
        <div style={{ marginTop: '1.5rem' }}>
          <video src={videoUrl} controls style={{ width: '100%', borderRadius: 8 }} />
          <a href={videoUrl} download style={{ display: 'block', marginTop: '0.75rem', textAlign: 'center', padding: '0.75rem', minHeight: 48, borderRadius: 8, border: '1px solid #ddd' }}>Download video</a>
        </div>
      )}

      <div style={{ marginTop: '2.5rem', borderTop: '1px solid #eee', paddingTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>History</h2>

        {historyLoading && <p style={{ color: '#666', fontSize: '0.9rem' }}>Loading past generations...</p>}

        {!historyLoading && history.length === 0 && (
          <p style={{ color: '#666', fontSize: '0.9rem' }}>Nothing generated yet. Your finished videos will show up here.</p>
        )}

        {history.map((item) => (
          <div key={item.id} style={{ marginBottom: '1.5rem' }}>
            <video src={item.video_url} controls style={{ width: '100%', borderRadius: 8 }} />
            <p style={{ fontSize: '0.85rem', color: '#333', marginTop: '0.4rem' }}>{item.prompt}</p>
            <p style={{ fontSize: '0.75rem', color: '#999' }}>
              {item.resolution} · {item.aspect_ratio || '16:9'} · {new Date(item.created_at).toLocaleString()}
              {item.timeline && item.timeline.length > 0 ? ` · ${item.timeline.length} timed actions` : ''}
              {item.seed ? ` · seed ${item.seed}` : ''}
            </p>
            <button
              onClick={() => handleRegenerate(item)}
              style={{ marginTop: '0.5rem', padding: '0.5rem 0.9rem', minHeight: 40, fontSize: '0.85rem', borderRadius: 8, border: '1px solid #ddd', background: '#fafafa' }}
            >
              Regenerate
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
         
     
