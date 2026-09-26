import { ArrowRight, BarChart3, Dumbbell, Swords, UsersRound } from 'lucide-react'
import { Link } from 'react-router'
import { destinations } from '../app/navigation'
import { PageHeader, Surface } from '../components/ui'
import './OverviewPage.css'

const sectionLinks = [
  { to: `${destinations.champions}?section=best`, eyebrow: 'Campioni', title: 'Quali giochi meglio?', copy: 'Confronta il rendimento storico con stime, intervalli e copertura dei dati.', icon: BarChart3 },
  { to: `${destinations.champions}?section=tournament`, eyebrow: 'Campioni', title: 'Piano da 400 partite', copy: 'Distribuisci il budget competitivo per identificare il campione migliore.', icon: Dumbbell },
  { to: destinations.matches, eyebrow: 'Le mie partite', title: 'Controlla le partite', copy: 'Esamina risultati, qualità e contesto delle singole partite.', icon: Swords },
  { to: destinations.companions, eyebrow: 'Compagni', title: 'Riconosci con chi giochi', copy: 'Trova i compagni e riunisci i Riot ID della stessa persona.', icon: UsersRound },
]

export function OverviewPage() {
  return <div className="page-stack overview-page">
    <PageHeader eyebrow="Punto di partenza" title="Riepilogo" copy="Apri le analisi competitive e consulta direttamente lo storico delle partite." />

    <Surface aria-labelledby="overview-start-title">
      <div className="section-heading"><div><p className="eyebrow">Analisi dei campioni</p><h2 id="overview-start-title">Rendimento storico e piano competitivo</h2></div></div>
      <p className="section-copy">Le risposte usano gli account attivi e le partite già analizzate. Il contesto e l’incertezza sono mostrati in ciascuna analisi.</p>
      <ol>
        <li><Link className="text-link" to={destinations.data}>Scegli gli account attivi</Link> nella pagina Dati usati.</li>
        <li>Se giochi spesso con le stesse persone, riunisci i loro Riot ID in <Link className="text-link" to={destinations.companions}>Compagni</Link>.</li>
        <li>Apri una delle due analisi competitive per confrontare i campioni o pianificare le partite.</li>
      </ol>
    </Surface>

    <section className="overview-destinations" aria-label="Sezioni operative">{sectionLinks.map(({ to, eyebrow, title, copy, icon: Icon }) => <Surface key={to}><p className="eyebrow"><Icon aria-hidden="true" /> {eyebrow}</p><h2>{title}</h2><p>{copy}</p><Link className="text-link" to={to}>Apri {title} <ArrowRight aria-hidden="true" /></Link></Surface>)}</section>
  </div>
}
