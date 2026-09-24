import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'

// ===== CONSTANTES MUSICAIS =====
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const A4_FREQ = 440

// Apenas duas escalas: Maior e Menor
const SCALES = {
  'Maior': [0, 2, 4, 5, 7, 9, 11],
  'Menor': [0, 2, 3, 5, 7, 8, 10],
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

// ===== DETECTOR DE ESCALA (APENAS MAIOR + MENOR) =====
function detectScale(detectedNotes, minNotes = 2) {
  if (detectedNotes.length < minNotes) return null

  const pitchClassWeights = new Array(12).fill(0)
  detectedNotes.forEach(note => {
    pitchClassWeights[note.midi % 12] += note.confidence || 1
  })

  const totalWeight = detectedNotes.reduce((sum, n) => sum + (n.confidence || 1), 0)
  const results = []

  // Testa Maior e Menor para cada tônica
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

  if (!results.length) return null

  // Ordena por score
  results.sort((a, b) => b.score - a.score)

  // Pega o melhor Maior e o melhor Menor separadamente
  const bestMajor = results.find(r => r.scale === 'Maior')
  const bestMinor = results.find(r => r.scale === 'Menor')

  // O "best" geral é o que tiver maior score
  const best = results[0]

  return { best, major: bestMajor, minor: bestMinor, all: results }
}

// ===== COMPONENTE PRINCIPAL =====
function App() {
  const [state, setState] = useState('idle') // idle, listening, result, error
  const [detectedScale, setDetectedScale] = useState(null)
  const [liveScaleCandidates, setLiveScaleCandidates] = useState([])
  const [liveNotes, setLiveNotes] = useState([])
  const [currentPitch, setCurrentPitch] = useState(null)
  const [confidence, setConfidence] = useState(0)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(0)

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
  const MIN_DURATION = 3000      // Mínimo 3s para começar a mostrar escala
  const MAX_DURATION = 30000     // Máximo 30s de segurança
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

    const finalScale = detectScale(finalNotes)
    setDetectedScale(finalScale)
    setState('result')
    setAutoStopped(false)
    stopListening()
  }, [stopListening])

  const startListening = useCallback(async () => {
    setError(null)
    setLiveNotes([])
    setDetectedScale(null)
    setLiveScaleCandidates([])
    setCurrentPitch(null)
    setConfidence(0)
    setProgress(0)
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

              const scaleResult = detectScale(uniqueNotes)
              if (scaleResult) {
                // Passa major e minor para o estado live
                const liveCandidates = []
                if (scaleResult.major) liveCandidates.push(scaleResult.major)
                if (scaleResult.minor) liveCandidates.push(scaleResult.minor)
                setLiveScaleCandidates(liveCandidates)
                // Não para automático — só mostra o palpite com alta confiança
                // O usuário decide quando parar
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
          const finalScale = detectScale(finalNotes)
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
    setLiveScaleCandidates([])
    setLiveNotes([])
    setCurrentPitch(null)
    setConfidence(0)
    setProgress(0)
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
        {/* IDLE - Mic icon is the button */}
        {state === 'idle' && (
          <div className="card idle-card">
            <button className="mic-button" onClick={startListening} aria-label="Iniciar detecção">
              <div className="mic-ring"></div>
              <svg className="mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
            </button>
            <h2>Toque no microfone e cante</h2>
            <p className="hint">(mín. 3s • máx. 30s • você para quando quiser)</p>
          </div>
        )}

        {/* LISTENING - Mic icon is the stop button */}
        {state === 'listening' && (
          <div className="card listening-card compact">
            <button className="mic-button listening" onClick={finishEarly} aria-label="Parar e ver resultado">
              <div className="mic-ring listening"></div>
              <div className="pulse-ring"></div>
              <svg className="mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
            </button>

            <h2>Ouvindo...</h2>
            <p className="instruction compact">
              {canAutoStop && liveScaleCandidates.some(c => c.coverage >= 0.8)
                ? 'Alta confiança — toque no microfone para ver resultado'
                : 'Cante naturalmente — analisando...'}
            </p>

            {/* Progress bar compacta */}
            <div className="progress-container compact">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress * 100}%` }}></div>
              </div>
              <span className="progress-time">
                {formatTime(elapsedMs)} {canAutoStop && liveScaleCandidates.length > 0 ? `• ${Math.round(Math.max(...liveScaleCandidates.map(c => c.coverage)) * 100)}%` : ''}
              </span>
            </div>

            {/* Nota atual compacta */}
            {currentPitch && (
              <div className="current-pitch compact">
                <span className="pitch-name">{currentPitch.name}</span>
                <div className="cents-indicator compact">
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

            {/* Palpite VIVO - Grid compacto */}
            {liveScaleCandidates.length > 0 && (
              <div className="live-guess compact">
                <div className="live-scales-grid">
                  {liveScaleCandidates.find(c => c.scale === 'Maior') && (
                    <div className="live-scale-box major">
                      <span className="live-scale-type">Maior</span>
                      <span className="live-scale-name">
                        {liveScaleCandidates.find(c => c.scale === 'Maior').tonic} Maior
                      </span>
                      <span className="live-scale-confidence">
                        {Math.round(liveScaleCandidates.find(c => c.scale === 'Maior').coverage * 100)}%
                      </span>
                    </div>
                  )}

                  {liveScaleCandidates.find(c => c.scale === 'Menor') && (
                    <div className="live-scale-box minor">
                      <span className="live-scale-type">Menor</span>
                      <span className="live-scale-name">
                        {liveScaleCandidates.find(c => c.scale === 'Menor').tonic} Menor
                      </span>
                      <span className="live-scale-confidence">
                        {Math.round(liveScaleCandidates.find(c => c.scale === 'Menor').coverage * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Placeholder compacto */}
            {!liveScaleCandidates.length && liveNotes.length < 2 && (
              <div className="waiting-guess compact">
                <p>Cante mais... ({liveNotes.length}/2)</p>
              </div>
            )}

            {/* Notas detectadas compactas */}
            {liveNotes.length > 0 && (
              <div className="detected-notes compact">
                <div className="notes-grid">
                  {liveNotes.map((note, i) => (
                    <span key={i} className="note-badge">{note}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Waveform menor */}
            <div className="waveform compact" aria-hidden="true">
              {[...Array(24)].map((_, i) => (
                <div key={i} className="wave-bar" style={{
                  animationDelay: `${i * 40}ms`,
                  height: `${25 + Math.random() * 55}%`
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

            <h2>Resultado Final</h2>

            {/* Duas colunas: Maior e Menor */}
            <div className="scales-grid">
              {/* Escala Maior */}
              {detectedScale.major && (
                <div className="scale-box major">
                  <div className="scale-box-header">
                    <span className="scale-type">Maior</span>
                    <span className="scale-confidence-badge">
                      {Math.round(detectedScale.major.coverage * 100)}%
                    </span>
                  </div>
                  <div className="scale-name-large">{detectedScale.major.tonic} Maior</div>
                  <div className="scale-notes">
                    {SCALES['Maior'].map((interval, i) => {
                      const noteName = NOTE_NAMES[(NOTE_NAMES.indexOf(detectedScale.major.tonic) + interval) % 12]
                      const isDetected = detectedScale.major.matchedNotes.includes(noteName)
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
              )}

              {/* Escala Menor */}
              {detectedScale.minor && (
                <div className="scale-box minor">
                  <div className="scale-box-header">
                    <span className="scale-type">Menor</span>
                    <span className="scale-confidence-badge">
                      {Math.round(detectedScale.minor.coverage * 100)}%
                    </span>
                  </div>
                  <div className="scale-name-large">{detectedScale.minor.tonic} Menor</div>
                  <div className="scale-notes">
                    {SCALES['Menor'].map((interval, i) => {
                      const noteName = NOTE_NAMES[(NOTE_NAMES.indexOf(detectedScale.minor.tonic) + interval) % 12]
                      const isDetected = detectedScale.minor.matchedNotes.includes(noteName)
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
              )}
            </div>

            {/* Se não achou um dos dois, mostra o melhor geral */}
            {!detectedScale.major && !detectedScale.minor && detectedScale.best && (
              <div className="scale-box single">
                <div className="scale-box-header">
                  <span className="scale-type">{detectedScale.best.scale}</span>
                  <span className="scale-confidence-badge">
                    {Math.round(detectedScale.best.coverage * 100)}%
                  </span>
                </div>
                <div className="scale-name-large">{formatScaleName(detectedScale.best)}</div>
                <div className="scale-notes">
                  {SCALES[detectedScale.best.scale].map((interval, i) => {
                    const noteName = NOTE_NAMES[(NOTE_NAMES.indexOf(detectedScale.best.tonic) + interval) % 12]
                    const isDetected = detectedScale.best.matchedNotes.includes(noteName)
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