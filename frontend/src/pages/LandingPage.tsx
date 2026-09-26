import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, BarChart3, Check, Compass, ScanSearch, ShieldCheck, Sparkles } from 'lucide-react'
import { Link } from 'react-router'
import { roleLabel } from '../app/labels'
import { BrandMark } from '../components/BrandMark'
import '../landing-experience.css'

const chapters = [
  { id: 'landing-main', label: 'La domanda' },
  { id: 'metodo', label: 'Il metodo' },
  { id: 'workflow', label: 'Le risposte' },
  { id: 'valore', label: 'Il perché' },
] as const

function ReadingGuide() {
  const [activeChapter, setActiveChapter] = useState<string>('landing-main')
  const progressRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sections = chapters.map(({ id }) => document.getElementById(id))
    let frame = 0
    const update = () => {
      frame = 0
      const available = document.documentElement.scrollHeight - window.innerHeight
      const progress = available > 0 ? Math.min(1, Math.max(0, window.scrollY / available)) : 0
      progressRef.current?.style.setProperty('--landing-progress', String(progress))
      let current: string = chapters[0].id
      sections.forEach((section, index) => {
        if (section && section.getBoundingClientRect().top <= window.innerHeight * 0.4) {
          current = chapters[index]!.id
        }
      })
      if (progress >= 0.99 && available > 0) current = chapters[chapters.length - 1]!.id
      setActiveChapter((previous) => previous === current ? previous : current)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(document.body)
    schedule()
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      resizeObserver.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <nav className="landing-guide" aria-label="Percorso di lettura">
      <span className="landing-guide__caption" aria-hidden="true">IL TUO PERCORSO</span>
      <ol>
        {chapters.map((chapter, index) => (
          <li key={chapter.id}>
            <a href={`#${chapter.id}`} aria-current={activeChapter === chapter.id ? 'location' : undefined}>
              <span className="landing-guide__index" aria-hidden="true">0{index + 1}</span>
              {chapter.label}
            </a>
          </li>
        ))}
      </ol>
      <div ref={progressRef} className="landing-guide__progress" aria-hidden="true" />
    </nav>
  )
}

function TacticalField() {
  return (
    <svg className="landing-tactical-field" viewBox="0 0 640 620" fill="none" aria-hidden="true" focusable="false">
      <g className="landing-tactical-field__grid">
        {[120, 200, 280, 360, 440, 520].map((position) => (
          <path key={position} d={`M${position} 30V590 M30 ${position}H610`} />
        ))}
        <circle cx="320" cy="310" r="268" />
        <circle cx="320" cy="310" r="228" strokeDasharray="2 10" />
      </g>
      <g className="landing-tactical-field__lanes">
        <path d="M104 512V190Q104 98 196 98H526V420Q526 512 434 512H104Z" />
        <path d="M104 512 526 98M104 472 486 98M144 512 526 138" />
        <path d="M104 336H200V420H304M328 98V202H426V300" strokeDasharray="5 8" />
        <path d="m104 494 18 18-18 18-18-18Zm422-414 18 18-18 18-18-18Z" />
      </g>
      <g className="landing-tactical-field__nodes">
        {[[104, 310], [320, 98], [526, 310], [320, 512], [320, 296]].map(([x, y]) => (
          <g key={`${x}-${y}`}>
            <circle cx={x} cy={y} r="13" />
            <circle cx={x} cy={y} r="3" fill="currentColor" />
          </g>
        ))}
        <path d="M308 28h24M320 16v24M308 592h24M320 580v24M28 298v24M16 310h24M612 298v24M600 310h24" />
      </g>
    </svg>
  )
}

const workflow = [
  { index: '01', label: 'Gioca', title: 'Chi mi conviene giocare?', copy: 'Una raccomandazione prudente e la matrice completa dell’evidenza.', to: '/app/fit' },
  { index: '02', label: 'Allena', title: 'Chi dovrei allenare per capire se fa per me?', copy: 'Il piano generale filtrato sui tuoi dati e le partite da distribuire.', to: '/app/test-plan' },
  { index: '03', label: 'Banna', title: 'Chi dovrei bannare?', copy: 'Gli avversari che penalizzano davvero il tuo rendimento sui dati selezionati.', to: '/app/champions' },
  { index: '04', label: 'Lascia', title: 'Chi non dovrei più giocare?', copy: 'Campioni da mettere in pausa e segnali che meritano ancora una verifica.', to: '/app/review/blacklist' },
]

function ProductPreview() {
  const sceneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const motion = window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)')
    let frame = 0
    let x = 0
    let y = 0
    const paint = () => {
      frame = 0
      scene.style.setProperty('--landing-tilt-x', `${-y * 2.5}deg`)
      scene.style.setProperty('--landing-tilt-y', `${x * 3}deg`)
      scene.style.setProperty('--landing-light-x', `${50 + x * 24}%`)
      scene.style.setProperty('--landing-light-y', `${50 + y * 24}%`)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(paint)
    }
    const reset = () => {
      x = 0
      y = 0
      schedule()
    }
    const move = (event: PointerEvent) => {
      if (!motion.matches || event.pointerType !== 'mouse') {
        reset()
        return
      }
      const bounds = scene.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return
      x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1))
      y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1))
      schedule()
    }
    scene.addEventListener('pointermove', move, { passive: true })
    scene.addEventListener('pointerleave', reset)
    scene.addEventListener('pointercancel', reset)
    motion.addEventListener('change', reset)
    window.addEventListener('blur', reset)
    return () => {
      scene.removeEventListener('pointermove', move)
      scene.removeEventListener('pointerleave', reset)
      scene.removeEventListener('pointercancel', reset)
      motion.removeEventListener('change', reset)
      window.removeEventListener('blur', reset)
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div ref={sceneRef} className="landing-preview-scene">
      <div className="landing-preview landing-preview--interactive" role="img" aria-label="Anteprima dimostrativa delle risposte con dati di esempio: tre scelte da giocare, quattrocento partite distribuite e quattro campioni esclusi. Nessun dato personale.">
        <div className="landing-preview__rail" aria-hidden="true">
          <BrandMark className="landing-preview__logo" />
          {Array.from({ length: 6 }).map((_, index) => <i key={index} />)}
        </div>
        <div className="landing-preview__canvas">
          <header>
            <div><span>LE TUE DOMANDE</span><strong>Prime risposte</strong></div>
            <span className="preview-scope">3 ACCOUNT ATTIVI</span>
          </header>
          <div className="preview-metrics">
            <article><small>CHI GIOCARE</small><strong>3 scelte</strong><span>stima prudente</span></article>
            <article><small>CHI ALLENARE</small><strong>400</strong><span>partite distribuite</span></article>
            <article><small>CHI LASCIARE</small><strong>4 esclusi</strong><span>nel ciclo corrente</span></article>
          </div>
          <div className="preview-lower">
            <section>
              <p>Evidenza per ruolo</p>
              {[
                ['TOP', 72], ['JUNGLE', 91], ['MIDDLE', 64], ['BOTTOM', 48], ['SUPPORT', 83],
              ].map(([role, value]) => (
                <div className="preview-bar" key={role}>
                  <span>{roleLabel(String(role), true)}</span><i><b style={{ width: `${value}%` }} /></i><em>{value}</em>
                </div>
              ))}
            </section>
            <section className="preview-decision">
              <span>CHI BANNARE</span>
              <strong>Il rischio emerge dalle tue partite.</strong>
              <p>La risposta considera sia i tuoi campioni nel complesso, sia ciascuno di loro.</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

export function LandingPage() {
  return (
    <div className="landing-page landing-experience">
      <a className="skip-link" href="#landing-main">Vai al contenuto</a>
      <header className="landing-nav">
        <Link className="brand brand--public" to="/" aria-label="Champion Fit, pagina iniziale">
          <BrandMark className="brand__mark" />
          <span>CHAMPION FIT</span>
        </Link>
        <nav aria-label="Navigazione della pagina iniziale">
          <a href="#metodo">Metodo</a>
          <a href="#workflow">Come funziona</a>
          <Link className="button button--compact" to="/app/overview">Vai alle risposte <ArrowRight aria-hidden="true" /></Link>
        </nav>
      </header>

      <ReadingGuide />

      <main id="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero__copy">
            <p className="eyebrow"><Sparkles aria-hidden="true" /> una domanda alla volta</p>
            <h1 id="landing-title">Hai una domanda sui tuoi campioni? <em className="landing-kinetic-answer">Qui trovi la risposta.</em></h1>
            <p className="landing-lede">
              Chi giocare, chi allenare, chi bannare e chi lasciare: ogni risposta dichiara quali dati usa e quanto è solido il segnale.
            </p>
            <div className="landing-actions">
              <Link className="button button--large" to="/app/overview">Vai alle tue risposte <ArrowRight aria-hidden="true" /></Link>
              <a className="button button--ghost button--large" href="#metodo">Scopri il metodo</a>
            </div>
            <ul className="landing-proof" aria-label="Caratteristiche principali">
              <li><Check aria-hidden="true" /> Dati sotto il tuo controllo</li>
              <li><Check aria-hidden="true" /> Nessuna metrica opaca</li>
              <li><Check aria-hidden="true" /> Decisioni tracciabili</li>
            </ul>
          </div>
          <div className="landing-hero__visual">
            <TacticalField />
            <div className="landing-visual-caption"><span className="landing-signal" aria-hidden="true" /> ANTEPRIMA DIMOSTRATIVA <span>DATI DI ESEMPIO</span></div>
            <div className="orbit-label orbit-label--one" aria-hidden="true">COMPATIBILITÀ / 74</div>
            <div className="orbit-label orbit-label--two" aria-hidden="true">EVIDENZA / 0,82</div>
            <ProductPreview />
            <p className="landing-visual-footnote"><span aria-hidden="true">CF / 01</span> Le 400 partite sono dati di esempio, non uno storico personale.</p>
          </div>
          <a className="landing-next-chapter" href="#metodo"><span>DAL RISULTATO ALLA SCELTA</span><ArrowDown aria-hidden="true" /><span>Esplora il metodo</span></a>
        </section>

        <section className="landing-problem" id="metodo" aria-labelledby="landing-method-title">
          <div>
            <p className="eyebrow">Il problema</p>
            <h2 id="landing-method-title">La percentuale di vittorie non basta per decidere.</h2>
          </div>
          <div className="landing-problem__body">
            <p>Partite anomale, poche osservazioni, ruoli diversi e compagni ricorrenti cambiano il significato del risultato. Champion Fit conserva questo contesto.</p>
            <div className="problem-grid">
              <article><BarChart3 aria-hidden="true" /><strong>Misura</strong><span>Distingue rendimento nei dati selezionati, modello generale e qualità dell'evidenza.</span></article>
              <article><ShieldCheck aria-hidden="true" /><strong>Controlla</strong><span>Rivedi le partite che possono distorcere il segnale.</span></article>
              <article><Compass aria-hidden="true" /><strong>Decidi</strong><span>Distribuisci le partite in base a quanto possono aiutarti a capire.</span></article>
            </div>
          </div>
        </section>

        <section className="landing-workflow" id="workflow" aria-labelledby="landing-workflow-title">
          <header>
            <p className="eyebrow">Quattro domande, quattro risposte</p>
            <h2 id="landing-workflow-title">Parti da ciò che vuoi sapere.</h2>
          </header>
          <div className="workflow-grid">
            {workflow.map((item) => (
              <Link className="landing-workflow-card" to={item.to} key={item.index}>
                <span>{item.index}</span>
                <p>{item.label}</p>
                <h3>{item.title}</h3>
                <div className="workflow-line" aria-hidden="true"><i /></div>
                <p className="workflow-copy">{item.copy}</p>
                <span className="workflow-cta">Apri la risposta <ArrowRight aria-hidden="true" /></span>
              </Link>
            ))}
          </div>
        </section>

        <section className="landing-value" id="valore" aria-labelledby="landing-value-title">
          <ScanSearch aria-hidden="true" />
          <p className="eyebrow">Il valore</p>
          <h2 id="landing-value-title">Prima la risposta.<br />Subito dopo, il perché.</h2>
          <p>Ogni risposta spiega perché una scelta è solida, provvisoria o ancora da verificare.</p>
          <Link className="button button--large" to="/app/overview">Apri le tue risposte <ArrowRight aria-hidden="true" /></Link>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="brand"><BrandMark className="brand__mark" /><span>CHAMPION FIT</span></div>
        <p>Decisioni migliori, una partita alla volta.</p>
        <small>Versione preliminare · dati locali · interfaccia italiana</small>
      </footer>
    </div>
  )
}
