import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'

// ===== CONSTANTES MUSICAIS =====
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const A4_FREQ = 440

const SCALES = {
  'Maior': [0, 2, 4, 5, 7, 9, 11],
  'Menor Natural': [0, 2, 3, 5, 7, 8, 10],
  'Menor Harmônica': [0, 2, 3, 5, 7, 8, 11],
  'Menor Melódica': [0, 2, 3, 5, 7, 9, 11],
  'Pentatônica Maior': [0, 2, 4, 7, 9],
  'Pentatônica Menor': [0, 3, 5, 7, 10],
  'Blues': [0, 3, 5, 6, 7, 10],
  'Dórica': [0, 2, 3, 5, 7, 9, 10],
  'Frígia': [0, 1, 3, 5, 7, 8, 10],
  'Lídia': [0, 2, 4, 6, 7, 9, 11],
  'Mixolídia': [0, 2, 4, 5, 7, 9, 10],
  'Lócris': [0, 1, 3, 5, 6, 8, 10],
}

// ===== UTILIDADES DE ÁUDIO =====
function freqToMidi(freq) {
  if (freq <= 0) return null
  return 69 + 12 * Math.log2(freq / A4_FREQ)
}

function midiToNoteName(midi) {
  const noteIndex = Math.round(midi) % 12
  const octave = Math.floor(Math.round(midi) / 12) - 1
  return `${NOTE_NAMES[noteIndex]}${octave}`
}

function getNoteFromFreq(freq) {
  const midi = freqToMidi(freq)
  if (midi === null) return null
  const noteName = midiToNoteName(midi)
  const cents = Math.round((midi - Math.round(midi)) * 100)
  return { name: noteName, midi: Math.round(midi), cents, freq }
}

// ===== DETECÇÃO DE PITCH (Autocorrelação) =====
class PitchDetector {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate
    this.minFreq = 80
    this.maxFreq = 1000
  }

  detectPitch(audioBuffer) {
    const data = audioBuffer
    const len = data.length

    const windowed = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      windowed[i] = data[i] * 0.5 * (1 - Math.cos(2 * Math.PI * i / (len - 1)))
    }

    const autocorr = new Float32Array(len)
    for (let lag = 0; lag < len; lag++) {
      let sum = 0
      for (let i = 0; i < len - lag; i++) {
        sum += windowed[i] * windowed[i + lag]
      }
      autocorr[lag] = sum
    }

    const maxVal = autocorr[0]
    if (maxVal === 0) return null
    for (let i = 0; i < len; i++) {
      autocorr[i] /= maxVal
    }

    const minLag = Math.floor(this.sampleRate / this.maxFreq)
    const maxLag = Math.floor(this.sampleRate / this.minFreq)

    let bestLag = -1
    let bestCorr = 0

    for (let lag = minLag; lag < maxLag && lag < len; lag++) {
      if (lag > 0 && lag < len - 1) {
        if (autocorr[lag] > autocorr[lag - 1] && autocorr[lag] > autocorr[lag + 1]) {
          if (autocorr[lag] > bestCorr) {
            bestCorr = autocorr[lag]
            bestLag = lag
          }
        }
      }
    }

    if (bestLag > 0 && bestLag < len - 1) {
      const y1 = autocorr[bestLag - 1]
      const y2 = autocorr[bestLag]
      const y3 = autocorr[bestLag + 1]
      const denom = (y1 - 2 * y2 + y3)
      if (denom !== 0) {
        const delta = (y3 - y1) / (2 * denom)
        bestLag += delta
      }
    }

    if (bestLag <= 0 || bestCorr < 0.3) return null

    const freq = this.sampleRate / bestLag
    const confidence = bestCorr

    return { freq, confidence }
  }
}

// ===== DETECTOR DE ESCALA =====
function detectAllScales(detectedNotes, minNotes = 2) {
  if (detectedNotes.length < minNotes) return []

  const pitchClassWeights = new Array(12).fill(0)
  detectedNotes.forEach(note => {
    pitchClassWeights[note.midi % 12] += note.confidence || 1
  })

  const totalWeight = detectedNotes.reduce((sum, n) => sum + (n.confidence || 1), 0)
  const results = []

  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [scaleName, intervals] of Object.entries(SCALES)) {
      let matchedWeight = 0
      const matched = []

      intervals.forEach(interval => {
        const pc = (tonic + interval) % 12
        const weight = pitchClassWeights[pc]
        if (weight > 0) {
          matchedWeight += weight
          matched.push(NOTE_NAMES[pc])
        }
      })

      const coverage = matchedWeight / totalWeight
      const noteCountRatio = matched.length / intervals.length
      const finalScore = matchedWeight * coverage * (0.5 + 0.5 * noteCountRatio)

      if (finalScore > 0) {
        results.push({
          scale: scaleName,
          tonic: NOTE_NAMES[tonic],
          score: finalScore,
          matchedNotes: matched,
          coverage,
          noteCountRatio,
          matchedWeight
        })
      }
    }
  }

  return results.sort((a, b) => b.score - a.score)
}

function getBestScale(detectedNotes) {
  const all = detectAllScales(detectedNotes)
  return all[0] || null
}

// Garante que a escala Maior esteja sempre nos resultados
function ensureMajorScale(candidates, detectedNotes) {
  if (!candidates.length) return candidates

  // Verifica se já tem uma escala Maior no top
  const hasMajor = candidates.some(c => c.scale === 'Maior')
  if (hasMajor) return candidates

  // Calcula a melhor escala Maior para as notas detectadas
  const majorScales = candidates.filter(c => c.scale === 'Maior')
  if (majorScales.length > 0) {
    // Adiciona a melhor Maior no topo se não estiver
    const bestMajor = majorScales[0]
    return [bestMajor, ...candidates.filter(c => c !== bestMajor)]
  }

  return candidates
}

// ===== COMPONENTE PRINCIPAL =====
function App() {
  const [state, setState] = useState('idle') // idle, listening, result, error
  const [detectedScale, setDetectedScale] = useState(null)
  const [liveScaleGuess, setLiveScaleGuess] = useState(null)
  const [liveScaleCandidates, setLiveScaleCandidates] = useState([])
  const [liveNotes, setLiveNotes] = useState([])
  const [currentPitch, setCurrentPitch] = useState(null)
  const [confidence, setConfidence] = useState(0)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(0)
  const [autoStopped, setAutoStopped] = useState(false)

  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const mediaStreamRef = useRef(null)
  const animationRef = useRef(null)
  const pitchDetectorRef = useRef(new PitchDetector())
  const noteBufferRef = useRef([])
  const startTimeRef = useRef(0)
  const lastScaleUpdateRef = useRef(0)
  const isListeningRef = useRef(false)

  // Configurações
  const MIN_DURATION = 3000      // Mínimo 3s antes de considerar auto-stop
  const MAX_DURATION = 30000     // Máximo 30s de segurança
  const TARGET_CONFIDENCE = 0.80 // 80% para parar automaticamente
  const LIVE_UPDATE_INTERVAL = 800

  // Cleanup ao desmontar
  useEffect(() => {
    return () => {
      stopListening()
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
    }
  }, [])

  const stopListening = useCallback(() => {
    isListeningRef.current = false
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop())
      mediaStreamRef.current = null
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect()
      analyserRef.current = null
    }
  }, [])

  const finishEarly = useCallback(() => {
    if (!isListeningRef.current) return

    const finalNotes = noteBufferRef.current.filter(n =>
      Date.now() - n.timestamp < MAX_DURATION + 500
    )

    const finalScale = getBestScale(finalNotes)
    setDetectedScale(finalScale)
    setState('result')
    setAutoStopped(false)
    stopListening()
  }, [stopListening])

  const startListening = useCallback(async () => {
    setError(null)
    setLiveNotes([])
    setDetectedScale(null)
    setLiveScaleGuess(null)
    setLiveScaleCandidates([])
    setCurrentPitch(null)
    setConfidence(0)
    setProgress(0)
    setAutoStopped(false)
    noteBufferRef.current = []
    startTimeRef.current = Date.now()
    lastScaleUpdateRef.current = 0
    isListeningRef.current = true

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 1
        }
      })

      mediaStreamRef.current = stream

      const audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000
      })
      audioContextRef.current = audioContext

      await audioContext.resume()

      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 8192
      analyser.smoothingTimeConstant = 0.3
      analyser.minDecibels = -100
      analyser.maxDecibels = -30

      source.connect(analyser)
      analyserRef.current = analyser

      setState('listening')

      const timeData = new Float32Array(analyser.fftSize)

      const analyzeLoop = () => {
        if (!analyserRef.current || !isListeningRef.current) return

        analyserRef.current.getFloatTimeDomainData(timeData)

        const result = pitchDetectorRef.current.detectPitch(timeData)

        if (result && result.confidence > 0.35) {
          const note = getNoteFromFreq(result.freq)
          if (note && Math.abs(note.cents) < 50) {
            setCurrentPitch(note)
            setConfidence(result.confidence)

            noteBufferRef.current.push({
              ...note,
              timestamp: Date.now(),
              confidence: result.confidence
            })

            const recent = noteBufferRef.current.filter(n =>
              Date.now() - n.timestamp < MAX_DURATION
            )

            const byPitchClass = {}
            recent.forEach(n => {
              const pc = n.midi % 12
              if (!byPitchClass[pc] || n.confidence > byPitchClass[pc].confidence) {
                byPitchClass[pc] = n
              }
            })

            const uniqueNotes = Object.values(byPitchClass)
            setLiveNotes(uniqueNotes.map(n => n.name))

            // ===== ANÁLISE VIVA A CADA 800ms =====
            const now = Date.now()
            if (now - lastScaleUpdateRef.current >= LIVE_UPDATE_INTERVAL && uniqueNotes.length >= 2) {
              lastScaleUpdateRef.current = now

              const allScales = detectAllScales(uniqueNotes)
              if (allScales.length > 0) {
                // Garante escala Maior nos candidatos
                const withMajor = ensureMajorScale(allScales, uniqueNotes)
                setLiveScaleGuess(withMajor[0])
                setLiveScaleCandidates(withMajor.slice(0, 4)) // Top 4

                // AUTO-STOP: se passou do mínimo e tem >80% confiança
                const elapsed = now - startTimeRef.current
                const topConfidence = withMajor[0].coverage
                if (elapsed >= MIN_DURATION && topConfidence >= TARGET_CONFIDENCE) {
                  // Para automaticamente com alta confiança
                  const finalNotes = noteBufferRef.current.filter(n =>
                    Date.now() - n.timestamp < MAX_DURATION + 500
                  )
                  const finalScale = getBestScale(finalNotes)
                  setDetectedScale(finalScale)
                  setState('result')
                  setAutoStopped(true)
                  stopListening()
                  return
                }
              }
            }
          }
        }

        // Atualizar progresso (baseado no tempo decorrido, max 30s)
        const elapsed = Date.now() - startTimeRef.current
        const prog = Math.min(elapsed / MAX_DURATION, 1)
        setProgress(prog)

        // Timeout máximo de segurança
        if (elapsed >= MAX_DURATION) {
          const finalNotes = noteBufferRef.current.filter(n =>
            Date.now() - n.timestamp < MAX_DURATION + 500
          )
          const finalScale = getBestScale(finalNotes)
          setDetectedScale(finalScale)
          setState('result')
          setAutoStopped(false)
          stopListening()
          return
        }

        animationRef.current = requestAnimationFrame(analyzeLoop)
      }

      analyzeLoop()

    } catch (err) {
      console.error('Erro ao acessar microfone:', err)
      setError('Não foi possível acessar o microfone. Verifique as permissões.')
      setState('error')
      stopListening()
    }
  }, [stopListening])

  const reset = useCallback(() => {
    stopListening()
    setState('idle')
    setDetectedScale(null)
    setLiveScaleGuess(null)
    setLiveScaleCandidates([])
    setLiveNotes([])
    setCurrentPitch(null)
    setConfidence(0)
    setProgress(0)
    setAutoStopped(false)
    noteBufferRef.current = []
  }, [stopListening])

  const formatScaleName = (scale) => {
    if (!scale) return ''
    return `${scale.tonic} ${scale.scale}`
  }

  const formatTime = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000))
    return `${s}s`
  }

  const elapsedMs = state === 'listening'
    ? Date.now() - startTimeRef.current
    : 0

  const remainingMs = state === 'listening'
    ? Math.max(0, MAX_DURATION - elapsedMs)
    : MAX_DURATION

  const canAutoStop = state === 'listening' && elapsedMs >= MIN_DURATION

  return (
    <div className="app">
      <header className="header">
        <h1>Descobrir Tom</h1>
        <p className="subtitle">Detector de Escala Musical</p>
      </header>

      <main className="main">
        {/* IDLE */}
        {state === 'idle' && (
          <div className="card idle-card">
            <div className="icon-wrapper">
              <svg className="mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
            </div>
            <h2>Toque no botão e cante</h2>
            <p>
              Vou ouvindo até ter <strong>80% de certeza</strong> da escala
              <br/>
              <span className="hint">(mín. 3s • máx. 30s • pode parar a qualquer momento)</span>
            </p>
            <button className="btn-primary btn-large" onClick={startListening}>
              <span className="btn-text">Descobrir Tom</span>
            </button>
          </div>
        )}

        {/* LISTENING */}
        {state === 'listening' && (
          <div className="card listening-card">
            <div className="status-indicator">
              <div className="pulse-ring"></div>
              <div className="mic-active">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="22"/>
                </svg>
              </div>
            </div>

            <h2>Ouvindo...</h2>
            <p className="instruction">
              {canAutoStop
                ? 'Confiança alta — vou parar automático ao atingir 80%'
                : 'Cante naturalmente — analisando em tempo real'}
            </p>

            {/* Progress bar */}
            <div className="progress-container">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress * 100}%` }}></div>
                {canAutoStop && liveScaleGuess && liveScaleGuess.coverage >= TARGET_CONFIDENCE && (
                  <div className="progress-target-marker" style={{ left: '80%' }}></div>
                )}
              </div>
              <span className="progress-time">
                {formatTime(elapsedMs)} decorridos {canAutoStop ? `• ${Math.round(liveScaleGuess?.coverage * 100 || 0)}% confiança` : ''}
              </span>
            </div>

            {/* Botão PARAR */}
            <button
              className="btn-stop"
              onClick={finishEarly}
              aria-label="Parar gravação e ver resultado agora"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
              <span>Parar e Ver Resultado</span>
            </button>

            {/* Nota atual */}
            {currentPitch && (
              <div className="current-pitch">
                <span className="pitch-label">Nota agora:</span>
                <span className="pitch-name">{currentPitch.name}</span>
                <div className="cents-indicator">
                  <div className="cents-bar">
                    <div
                      className="cents-marker"
                      style={{ left: `calc(50% + ${Math.max(-50, Math.min(50, currentPitch.cents))}%)` }}
                    ></div>
                  </div>
                  <span className="cents-value">
                    {currentPitch.cents > 0 ? '+' : ''}{currentPitch.cents}¢
                  </span>
                </div>
              </div>
            )}

            {/* Palpite VIVO */}
            {liveScaleGuess && (
              <div className="live-guess">
                <div className="guess-header">
                  <span className="guess-badge">
                    {canAutoStop && liveScaleGuess.coverage >= TARGET_CONFIDENCE
                      ? 'PRONTO — PARANDO...'
                      : 'PALPITE ATUAL'}
                  </span>
                  <span className="guess-confidence">
                    {Math.round(liveScaleGuess.coverage * 100)}% match
                  </span>
                </div>
                <div className="guess-main">
                  <span className="guess-scale-name">{formatScaleName(liveScaleGuess)}</span>
                  <span className="guess-sub">baseado em {liveNotes.length} nota{liveNotes.length !== 1 ? 's' : ''}</span>
                </div>

                {liveScaleCandidates.length > 1 && (
                  <div className="guess-alternatives">
                    <span className="alt-label">Outras possibilidades:</span>
                    <div className="alt-list">
                      {liveScaleCandidates.slice(1).map((c, i) => (
                        <div key={i} className="alt-item">
                          <span className="alt-name">{formatScaleName(c)}</span>
                          <span className="alt-percent">{Math.round(c.coverage * 100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Placeholder */}
            {!liveScaleGuess && liveNotes.length < 2 && (
              <div className="waiting-guess">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{width: 32, height: 32, marginBottom: 8, opacity: 0.5}}>
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 6v6l4 2"/>
                </svg>
                <p>Cante mais algumas notas para eu analisar...</p>
                <span className="notes-count">{liveNotes.length}/2 notas mínimas</span>
              </div>
            )}

            {/* Notas detectadas */}
            {liveNotes.length > 0 && (
              <div className="detected-notes">
                <span className="notes-label">Notas únicas encontradas:</span>
                <div className="notes-grid">
                  {liveNotes.map((note, i) => (
                    <span key={i} className="note-badge">{note}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Waveform */}
            <div className="waveform" aria-hidden="true">
              {[...Array(32)].map((_, i) => (
                <div key={i} className="wave-bar" style={{
                  animationDelay: `${i * 50}ms`,
                  height: `${20 + Math.random() * 60}%`
                }}></div>
              ))}
            </div>
          </div>
        )}

        {/* RESULT FINAL */}
        {state === 'result' && detectedScale && (
          <div className="card result-card">
            <div className="result-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </div>

            <h2>
              {autoStopped
                ? 'Resultado (parou automático ≥80%)'
                : 'Resultado Final'}
            </h2>
            <div className="scale-result">
              <span className="scale-name">{formatScaleName(detectedScale)}</span>
              <span className="scale-confidence">
                {Math.round(detectedScale.coverage * 100)}% de correspondência
              </span>
            </div>

            <div className="scale-details">
              <h3>Notas da escala {detectedScale.scale}:</h3>
              <div className="scale-notes">
                {SCALES[detectedScale.scale].map((interval, i) => {
                  const noteName = NOTE_NAMES[(NOTE_NAMES.indexOf(detectedScale.tonic) + interval) % 12]
                  const isDetected = detectedScale.matchedNotes.includes(noteName)
                  return (
                    <span
                      key={i}
                      className={`scale-note ${isDetected ? 'detected' : ''}`}
                    >
                      {noteName}
                    </span>
                  )
                })}
              </div>
            </div>

            {/* Sempre mostra a escala Maior correspondente */}
            {detectedScale.scale !== 'Maior' && (() => {
              const majorTonic = detectedScale.tonic
              const majorIntervals = SCALES['Maior']
              return (
                <div className="major-scale-box">
                  <h3>Escala Maior relativa (para referência):</h3>
                  <div className="major-scale-info">
                    <div className="scale-notes">
                      {majorIntervals.map((interval, i) => {
                        const noteName = NOTE_NAMES[(NOTE_NAMES.indexOf(majorTonic) + interval) % 12]
                        const isDetected = detectedScale.matchedNotes.includes(noteName)
                        return (
                          <span
                            key={i}
                            className={`scale-note ${isDetected ? 'detected' : ''} major-ref`}
                          >
                            {noteName}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                  <p className="major-hint">{majorTonic} Maior — {detectedScale.scale} de {detectedScale.tonic}</p>
                </div>
              )
            })()}

            {/* Top alternativas */}
            {liveScaleCandidates.length > 1 && (
              <div className="final-alternatives">
                <h3>Outras escalas compatíveis:</h3>
                <div className="alt-list">
                  {liveScaleCandidates.slice(1, 5).map((c, i) => (
                    <div key={i} className="alt-item">
                      <span className="alt-rank">#{i + 2}</span>
                      <span className="alt-name">{formatScaleName(c)}</span>
                      <span className="alt-percent">{Math.round(c.coverage * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="result-actions">
              <button className="btn-secondary" onClick={reset}>
                Nova Análise
              </button>
            </div>
          </div>
        )}

        {/* RESULT SEM ESCALA */}
        {state === 'result' && !detectedScale && (
          <div className="card result-card">
            <div className="result-icon" style={{background: 'var(--accent-warm-bg)', borderColor: 'rgba(255,107,107,0.3)'}}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{color: 'var(--accent-warm)'}}>
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>

            <h2>Não consegui identificar</h2>
            <p style={{color: 'var(--fg-muted)', marginBottom: '1.5rem'}}>
              Não detectei notas suficientes ou claras o suficiente para determinar a escala.
            </p>
            <div className="result-actions">
              <button className="btn-primary" onClick={reset}>
                Tentar Novamente
              </button>
            </div>
          </div>
        )}

        {/* ERROR */}
        {state === 'error' && (
          <div className="card error-card">
            <div className="error-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
            </div>
            <h2>Erro</h2>
            <p>{error}</p>
            <button className="btn-primary" onClick={reset}>
              Tentar Novamente
            </button>
          </div>
        )}
      </main>

      <footer className="footer">
        <p>Funciona offline • PWA instalável • Privacidade total (processamento local)</p>
      </footer>
    </div>
  )
}

export default App