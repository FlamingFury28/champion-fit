import { ArrowRight, BarChart3, Dumbbell } from 'lucide-react'
import { Link } from 'react-router'
import { destinations } from '../app/navigation'
import { PageHeader, Surface } from '../components/ui'
import './OverviewPage.css'

const sectionLinks = [
  { to: `${destinations.champions}?section=best`, eyebrow: 'Campioni', title: 'Quali giochi meglio?', copy: 'Confronta il rendimento storico con stime, intervalli e copertura dei dati.', icon: BarChart3 },
  { to: `${destinations.champions}?section=tournament`, eyebrow: 'Campioni', title: 'Piano da 400 partite', copy: 'Distribuisci il budget competitivo per identificare il campione migliore.', icon: Dumbbell },
]

export function OverviewPage() {
  return <div className="page-stack overview-page">
    <PageHeader eyebrow="Punto di partenza" title="Riepilogo" copy="Apri le analisi competitive e consulta direttamente lo storico delle partite." />

    <section className="overview-destinations" aria-label="Analisi competitive">{sectionLinks.map(({ to, eyebrow, title, copy, icon: Icon }) => <Surface key={to}><p className="eyebrow"><Icon aria-hidden="true" /> {eyebrow}</p><h2>{title}</h2><p>{copy}</p><Link className="text-link" to={to}>Apri {title} <ArrowRight aria-hidden="true" /></Link></Surface>)}</section>

    <Surface aria-labelledby="overview-start-title">
      <div className="section-heading"><div><h2 id="overview-start-title">Controlla i dati delle analisi</h2></div></div>
      <p className="section-copy">Le analisi usano gli account attivi e le partite già importate. Puoi <Link className="text-link" to={destinations.data}>scegliere i dati usati</Link> e <Link className="text-link" to={destinations.matches}>consultare lo storico delle partite</Link>. Contesto e incertezza sono mostrati in ciascuna analisi.</p>
      <p className="section-copy">Per esaminare le partite condivise e raggruppare i Riot ID delle persone con cui giochi, apri <Link className="text-link" to={destinations.companions}>Compagni</Link>.</p>
    </Surface>
  </div>
}
