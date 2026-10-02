import { ArrowRight, BarChart3, Compass, Search, Settings2, Swords, UsersRound, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { destinations } from '../app/navigation'
import { PageHeader } from '../components/ui'

interface MapItem {
  title: string
  description: string
  to: string
  keywords: string
}

interface MapSection {
  id: string
  title: string
  description: string
  icon: LucideIcon
  items: MapItem[]
}

const sections: MapSection[] = [
  {
    id: 'inizia',
    title: 'Inizia da qui',
    description: 'Orientati e scegli quali dati usare.',
    icon: Compass,
    items: [
      { title: 'Riepilogo', description: 'Apri rendimento storico e piano competitivo.', to: destinations.overview, keywords: 'inizio panoramica rendimento piano risposte' },
      { title: 'Dati usati', description: 'Scegli account, profili salvati e presenza dei compagni.', to: destinations.data, keywords: 'account profilo filtri selezione dati contesto' },
    ],
  },
  {
    id: 'campioni',
    title: 'Campioni',
    description: 'Confronta il rendimento storico e prepara il piano competitivo.',
    icon: Swords,
    items: [
      { title: 'Quali giochi meglio?', description: 'Confronta il rendimento storico per account, ruolo, modalità e periodo.', to: `${destinations.champions}?section=best`, keywords: 'migliore campioni performance rendimento torneo' },
      { title: 'Piano da 400 partite', description: 'Distribuisci un budget competitivo per identificare i campioni più promettenti.', to: `${destinations.champions}?section=tournament`, keywords: '400 partite budget piano competitivo rimpianto' },
    ],
  },
  {
    id: 'partite',
    title: 'Partite e analisi',
    description: 'Controlla lo storico e cerca spunti per migliorare.',
    icon: BarChart3,
    items: [
      { title: 'Andamento personale', description: 'Consulta risultati recenti, ruoli e partite giocate.', to: `${destinations.matches}?section=history`, keywords: 'storico andamento vittorie sconfitte risultati ruoli' },
      { title: 'Partite e annotazioni', description: 'Filtra le partite, aggiungi note e rivedi il contesto.', to: `${destinations.matches}?section=history&flag=all`, keywords: 'rivedere revisione annota annotazioni note afk sconfitte' },
      { title: 'Stile di gioco', description: 'Confronta il tuo comportamento tra vittorie e sconfitte.', to: `${destinations.matches}?section=style`, keywords: 'stile comportamenti visione farm danni confronto' },
    ],
  },
  {
    id: 'squadra',
    title: 'Confronti e squadra',
    description: 'Analisi aggiuntive su campioni avversari, alleati e persone.',
    icon: UsersRound,
    items: [
      { title: 'Avversari e ban', description: 'Confronta i risultati osservati nei matchup.', to: `${destinations.champions}?section=matchups&relation=enemies`, keywords: 'nemici avversari matchup counter ban bannare' },
      { title: 'Campioni alleati', description: 'Esplora i confronti con i campioni della tua squadra.', to: `${destinations.champions}?section=matchups&relation=allies`, keywords: 'sinergia alleati squadra compagni champion' },
      { title: 'Compagni di squadra', description: 'Trova chi gioca con te e raggruppa i Riot ID.', to: destinations.companions, keywords: 'amici persone riot id gruppi alleati giocatori' },
    ],
  },
  {
    id: 'preferenze',
    title: 'Preferenze e prove (facoltative)',
    description: 'Suggerimenti personali basati sui campioni giocati e sui gusti dichiarati.',
    icon: Compass,
    items: [
      { title: 'Familiari e preferiti', description: 'Rivedi i campioni giocati e le preferenze che hai indicato.', to: `${destinations.champions}?section=choices`, keywords: 'le mie scelte giocare preferiti familiari gusti risultati pick' },
      { title: 'Scopri candidati', description: 'Trova campioni nuovi affini alle scelte già osservate.', to: `${destinations.champions}?section=training&training=discover`, keywords: 'scoprire nuovi candidati alternative esplorare' },
      { title: 'Piano di prove', description: 'Organizza prove brevi, una partita per candidato.', to: `${destinations.champions}?section=training&training=plan`, keywords: 'allenamento provare test piano sessioni' },
    ],
  },
  {
    id: 'impostazioni',
    title: 'Impostazioni',
    description: 'Configura i criteri che guidano le raccomandazioni.',
    icon: Settings2,
    items: [
      { title: 'Algoritmi', description: 'Rivedi e modifica i parametri delle analisi.', to: destinations.algorithmSettings, keywords: 'algoritmo criteri pesi parametri configurazione' },
    ],
  },
]

function matchesSearch(section: MapSection, item: MapItem, query: string) {
  const text = `${section.title} ${item.title} ${item.description} ${item.keywords}`.toLocaleLowerCase('it-IT')
  return text.includes(query)
}

export function SiteMapPage() {
  const [search, setSearch] = useState('')
  const query = search.trim().toLocaleLowerCase('it-IT')
  const visibleSections = useMemo(() => sections.flatMap((section) => {
    const items = query ? section.items.filter((item) => matchesSearch(section, item, query)) : section.items
    return items.length ? [{ ...section, items }] : []
  }), [query])
  const resultCount = visibleSections.reduce((count, section) => count + section.items.length, 0)

  return <div className="page-stack site-map-page">
    <PageHeader eyebrow="Esplora Champion Fit" title="Mappa del sito" copy="Cerca quello che vuoi fare oppure scegli una sezione per aprirla direttamente." />
    <div className="site-map-search-row">
      <label>
        <span>Cerca una funzione</span>
        <span><Search aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Es. ban, account, stile di gioco" /></span>
      </label>
      <p role="status" aria-live="polite">{resultCount} {resultCount === 1 ? 'voce' : 'voci'}{query ? ' trovate' : ' disponibili'}</p>
    </div>
    {visibleSections.length ? <nav className="site-map-grid" aria-label="Sezioni del sito">
      {visibleSections.map((section) => {
        const Icon = section.icon
        return <section className="site-map-group" key={section.id} aria-labelledby={`site-map-${section.id}`}>
          <div className="site-map-group__heading">
            <Icon aria-hidden="true" />
            <div><h2 id={`site-map-${section.id}`}>{section.title}</h2><p>{section.description}</p></div>
          </div>
          <div className="site-map-group__links">
            {section.items.map((item) => <Link className="site-map-card" key={item.title} to={item.to}>
              <span><strong>{item.title}</strong><small>{item.description}</small></span>
              <ArrowRight aria-hidden="true" />
            </Link>)}
          </div>
        </section>
      })}
    </nav> : <p className="site-map-empty" role="status">Non trovo sezioni per “{search}”. Prova con un altro termine.</p>}
  </div>
}
