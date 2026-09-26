import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, BookOpen, ChevronDown, Compass, Eye, Layers3 } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { scopeQuery, type ScopeSnapshot } from '../api/client'
import { playstyleEvidenceQuery, playstylesQuery, type PlaystyleBehavior, type PlaystyleCategory, type PlaystyleComparison, type PlaystyleDays, type PlaystyleFilters, type PlaystyleSource, type PlaystylesResponse } from '../api/playstyles'
import { formatDate } from '../app/filters'
import { credibleMassLabel, getSetting, useAlgorithmSettings } from '../app/algorithm-settings'
import { roleLabel } from '../app/labels'
import { championHref } from '../app/navigation'
import { useScope } from '../app/scope'
import { BehaviorRadar } from '../components/BehaviorRadar'
import { DataExplorer } from '../components/DataExplorer'
import { DataTable, EmptyState, ErrorState, FilterBar, MetricCard, PageHeader, Skeleton, StatusBadge, Surface } from '../components/ui'
import '../playstyles.css'

const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('it-IT', { maximumFractionDigits: digits })
const percentage = (value: number | null | undefined) => value == null ? 'Non stimabile' : `${number(value)}%`
const liftLabel = (value: number | null | undefined) => value == null ? 'Confronto non stimabile' : `${value > 0 ? '+' : ''}${number(value)} punti`
const kindLabel = (kind: string) => /class/i.test(kind) ? 'Classe' : 'Stile dettagliato'
const interval = (item: { lower?: number | null; upper?: number | null; lower_90?: number | null; upper_90?: number | null }) => ({
  lower: item.lower ?? item.lower_90,
  upper: item.upper ?? item.upper_90,
})
const baselineInterval = (item: PlaystyleCategory) => ({
  lower: item.baseline_lower ?? item.baseline_lower_90,
  upper: item.baseline_upper ?? item.baseline_upper_90,
})

function Sources({ sources }: { sources: PlaystyleSource[] }) {
  return <ul className="playstyles-sources">{sources.map((source, index) => {
    const url = typeof source === 'string' ? source : source.url
    const label = typeof source === 'string' ? source : source.label ?? source.name ?? source.url ?? 'Fonte del catalogo'
    return <li key={`${url}-${index}`}>{url && /^https?:\/\//i.test(url) ? <a href={url} target="_blank" rel="noreferrer">{label}</a> : label}</li>
  })}</ul>
}

function Evidence({ scope, filters, category }: { scope: ScopeSnapshot; filters: PlaystyleFilters; category: PlaystyleCategory }) {
  const [page, setPage] = useState(1)
  const evidence = useQuery(playstyleEvidenceQuery(scope, filters, category.id, page))
  return <div className="playstyles-evidence" aria-live="polite">
    <h4>Partite a supporto · {category.label}</h4>
    <p>Una riga per account e partita. Una partita condivisa può comparire per più account.</p>
    {evidence.isPending ? <Skeleton lines={4} label="Caricamento partite dell’archetipo" /> : null}
    {evidence.isError ? <ErrorState error={evidence.error} onRetry={() => void evidence.refetch()} /> : null}
    {evidence.data ? <>
      {evidence.data.matches.length ? <DataTable label={`Partite a supporto di ${category.label}`}>
        <thead><tr><th>Esito</th><th>Campione</th><th>Account</th><th>Partita</th><th>Data</th><th>Note</th></tr></thead>
        <tbody>{evidence.data.matches.map((match) => <tr key={`${match.account}-${match.match_id}`}>
          <td><StatusBadge tone={match.win ? 'positive' : 'negative'}>{match.win ? 'Vittoria' : 'Sconfitta'}</StatusBadge></td>
          <th scope="row">{match.champion}<small className="playstyles-cell-detail">{roleLabel(match.role)} · {number(match.duration_minutes)} min</small></th>
          <td>{match.account}</td><td>{match.match_id}</td><td>{formatDate(match.date)}</td><td>{match.note || '—'}</td>
        </tr>)}</tbody>
      </DataTable> : <p className="micro-empty">Nessuna partita in questa pagina per i filtri attivi.</p>}
      <nav className="playstyles-pagination" aria-label={`Paginazione prove ${category.label}`}>
        <button type="button" className="button button--secondary" disabled={page <= 1 || evidence.isFetching} onClick={() => setPage((value) => value - 1)}>Precedente</button>
        <span>Pagina {evidence.data.page} di {Math.max(1, Math.ceil(evidence.data.total / evidence.data.page_size))} · {evidence.data.total} righe</span>
        <button type="button" className="button button--secondary" disabled={page * evidence.data.page_size >= evidence.data.total || evidence.isFetching} onClick={() => setPage((value) => value + 1)}>Successiva</button>
      </nav>
    </> : null}
  </div>
}

function CategoryCard({ item, scope, filters, trainingHref, inExplorer = false }: { item: PlaystyleCategory; scope: ScopeSnapshot; filters: PlaystyleFilters; trainingHref: string; inExplorer?: boolean }) {
  const { credibleMass: confidenceMass } = useAlgorithmSettings()
  const [expanded, setExpanded] = useState(false)
  const [showMatches, setShowMatches] = useState(false)
  const supported = item.supported
  const bounds = interval(item)
  const baselineBounds = baselineInterval(item)
  return <article className={inExplorer ? undefined : 'playstyles-category'} data-supported={supported}>
    {!inExplorer ? <><div className="playstyles-category-heading"><div><p className="eyebrow">{kindLabel(item.kind)}</p><h3>{item.label}</h3></div>
      <StatusBadge tone={supported ? 'positive' : 'warning'}>{supported ? 'Segnale supportato' : 'Da esplorare'}</StatusBadge>
    </div>
    <div className="playstyles-estimate"><strong>{percentage(item.mean)}</strong><span>vittorie osservate<br />intervallo binomiale al {credibleMassLabel(confidenceMass)} {number(bounds.lower)}–{number(bounds.upper)}%</span></div></> : null}
    <div className="playstyles-lift" data-direction={item.lift != null && item.lift > 0 ? 'above' : 'other'}>
      {item.lift == null ? null : item.lift > 0 ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}<strong>{liftLabel(item.lift)}</strong><span>{item.missing_baseline_accounts.length ? 'rispetto al riferimento disponibile · copertura incompleta' : 'rispetto alle altre scelte nel contesto selezionato'}</span>
    </div>
    {!inExplorer ? <p className="playstyles-support">{item.games} partite uniche · {item.comparable_accounts}/{item.account_count} account confrontabili</p> : null}
    {item.missing_accounts.length || item.missing_baseline_accounts.length ? <p className="playstyles-coverage-gap">Copertura incompleta: il risultato non descrive tutti gli account selezionati.</p> : null}
    {item.reasons.length ? <ul className="playstyles-reasons">{item.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
    <div className="playstyles-card-actions">
      <Link className="button button--secondary" to={trainingHref}>Esplora i campioni · {item.label}</Link>
      <button type="button" className="button button--ghost" aria-expanded={expanded} aria-controls={`playstyle-details-${item.id}`} onClick={() => setExpanded((value) => !value)}><ChevronDown aria-hidden="true" /> Perché {item.label}?</button>
    </div>
    {expanded ? <div id={`playstyle-details-${item.id}`} className="playstyles-details">
      <h4>Criterio della categoria</h4><p>{Array.isArray(item.criteria) ? item.criteria.join(' · ') : item.criteria}</p>
      {item.baseline_mean == null || item.baseline_games <= 0 ? <p>Riferimento non disponibile nel contesto selezionato.</p> : <p>Riferimento osservato: {percentage(item.baseline_mean)} · intervallo binomiale al {credibleMassLabel(confidenceMass)} {number(baselineBounds.lower)}–{number(baselineBounds.upper)}% · {item.baseline_games} partite.</p>}
      <h4>Da quali campioni arriva il risultato?</h4>
      {item.composition.length ? <ul className="playstyles-composition">{item.composition.map((champion) => <li key={champion.champion}><strong>{champion.name || champion.champion}</strong><span>{champion.games} partite · {champion.wins}V / {champion.losses}S</span></li>)}</ul> : <p>Composizione non disponibile.</p>}
      {item.sensitivity?.champion ? <p className="playstyles-sensitivity"><strong>Senza {item.sensitivity.champion}:</strong> {item.sensitivity.games} partite rimaste · {liftLabel(item.sensitivity.lift)}. {item.sensitivity.depends_on_champion ? 'Il risultato dipende da questo campione; non basta a confermare l’intero archetipo.' : item.sensitivity.supported ? 'Il segnale resta supportato anche escludendolo.' : 'Il campione residuo non conferma un vantaggio dell’archetipo.'}</p> : <p className="playstyles-sensitivity">Sensibilità al singolo campione non stimabile con questi dati.</p>}
      <h4>Copertura per account</h4>
      <ul className="playstyles-account-support">{Object.entries(item.support_per_account).map(([account, support]) => <li key={account}><strong>{account}</strong><span>{support.games} partite · {support.baseline_games} di confronto{support.local_missing ? ' · dati locali mancanti' : ''}</span></li>)}</ul>
      {item.missing_baseline_accounts.length ? <p>Riferimento personale mancante: {item.missing_baseline_accounts.join(', ')}. Il 50% neutro non rappresenta risultati osservati con altre scelte.</p> : null}
      <p className="playstyles-method">Confronto corretto per una famiglia di {item.family_size} categorie, con intervalli per account. Gli account hanno uguale peso; i tag possono sovrapporsi. La ricerca e l’ordinamento di questa pagina non cambiano l’analisi.</p>
      <Sources sources={item.sources} />
      <button type="button" className="button button--secondary" aria-expanded={showMatches} onClick={() => setShowMatches((value) => !value)}><Eye aria-hidden="true" />{showMatches ? 'Nascondi le partite' : `Mostra le partite · ${item.label}`}</button>
      {showMatches ? <Evidence scope={scope} filters={filters} category={item} /> : null}
    </div> : null}
  </article>
}

function Distribution({ comparison, unit, label }: { comparison: PlaystyleComparison; unit: string; label: string }) {
  return <div className="playstyles-distribution"><h4>{label}</h4>
    <div className="playstyles-outcomes">{(['wins', 'losses'] as const).map((outcome) => {
      const values = comparison[outcome]
      return <div key={outcome} data-outcome={outcome}><span>{outcome === 'wins' ? 'Nelle vittorie' : 'Nelle sconfitte'}</span>
        <strong>{values ? `${number(values.median)} ${unit}` : 'Non disponibile'}</strong>
        <small>{values ? `Metà dei valori: ${number(values.q1)}–${number(values.q3)} · ${values.n} partite` : 'Dati insufficienti per questo confronto'}</small>
      </div>
    })}</div>
    <p>{comparison.accounts} account confrontabili{comparison.excluded_accounts.length ? ` · esclusi dal confronto: ${comparison.excluded_accounts.join(', ')}` : ''}</p>
  </div>
}

function BehaviorCard({ item }: { item: PlaystyleBehavior }) {
  return <article className="playstyles-behavior"><h3>{item.label}</h3>
    <Distribution comparison={item.raw} label="Valori osservati a fine partita" unit={item.unit} />
    <Distribution comparison={item.percentiles} label="Posizione nel tuo contesto · percentile 0–100" unit="/ 100" />
  </article>
}

function Suggestions({ data, params }: { data: PlaystylesResponse; params: URLSearchParams }) {
  const { credibleMass: confidenceMass } = useAlgorithmSettings()
  const suggestions = data.suggestions
  const label = data.catalog.categories.find((item) => item.id === suggestions.category_id)?.label
  return <Surface className="playstyles-suggestions" id="playstyle-suggestions">
    <div className="section-heading"><div><p className="eyebrow"><Compass aria-hidden="true" /> Dal segnale alla scelta</p><h2>{label ? `Campioni · ${label}` : 'Esplora i campioni di una categoria'}</h2></div></div>
    {suggestions.exploratory ? <p className="playstyles-coverage-gap">Selezione esplorativa: il campione disponibile non conferma ancora un vantaggio dell’archetipo.</p> : null}
    <div className="playstyles-suggestion-columns">
      <div><h3>Già giocati</h3><p>Risultati osservati nel ruolo, nella coda e nel periodo selezionati.</p>
        {suggestions.played.length ? <ul className="playstyles-champions">{suggestions.played.map((item) => { const bounds = interval(item); return <li key={item.champion}><strong><Link state={{ championSheetFromList: true }} to={championHref(item.champion, data.filters.role, params)}>{item.name || item.champion}</Link></strong><span>{item.games} partite · {item.wins}V / {item.losses}S</span><b>{percentage(item.mean)}</b><small>Intervallo binomiale al {credibleMassLabel(confidenceMass)} {number(bounds.lower)}–{number(bounds.upper)}%</small></li> })}</ul> : <p className="micro-empty">Nessun campione già giocato in questa categoria e in questo contesto.</p>}
      </div>
      <div><h3>Mai provati</h3><p>Affinità di catalogo. Non è una probabilità di vittoria né una prova di compatibilità personale.</p>
        <p>Affinità di catalogo: sovrapposizione dei tag da 0 a 1, rispetto al campione di riferimento più simile della categoria.</p>
        {suggestions.untried.length ? <ul className="playstyles-champions">{suggestions.untried.map((item) => <li key={item.champion}><strong><Link state={{ championSheetFromList: true }} to={championHref(item.champion, data.filters.role || item.roles[0] || '', params)}>{item.name || item.champion}</Link></strong><StatusBadge tone="info">Ipotesi teorica</StatusBadge><span>{item.label} · affinità catalogo {number(item.similarity, 2)} / 1</span><small>{item.roles.map((role) => roleLabel(role)).join(' · ')}</small></li>)}</ul> : <p className="micro-empty">Nessuna proposta mai provata disponibile.</p>}
      </div>
    </div>
  </Surface>
}

function Results({ data, scope, filters, trainingHref }: { data: PlaystylesResponse; scope: ScopeSnapshot; filters: PlaystyleFilters; trainingHref: (category: string) => string }) {
  const [search, setSearch] = useState('')
  const [order, setOrder] = useState('support')
  const searchTerm = search.trim().toLocaleLowerCase('it')
  const categories = data.categories.filter((item) => {
    if (!searchTerm) return true
    const criteria = Array.isArray(item.criteria) ? item.criteria.join(' ') : item.criteria
    return [item.label, kindLabel(item.kind), criteria, ...item.roles.map((role) => roleLabel(role))].join(' ').toLocaleLowerCase('it').includes(searchTerm)
  }).sort((left, right) => {
    if (order === 'name') return left.label.localeCompare(right.label, 'it')
    if (order === 'games') return right.games - left.games || left.label.localeCompare(right.label, 'it')
    return Number(right.supported) - Number(left.supported) || (right.lift ?? -Infinity) - (left.lift ?? -Infinity) || right.games - left.games || left.id.localeCompare(right.id)
  })
  const firstSupported = data.categories.filter((item) => item.supported).sort((left, right) => (right.lift ?? -Infinity) - (left.lift ?? -Infinity) || right.games - left.games || left.id.localeCompare(right.id))[0]
  return <>
    <section className="metric-grid" aria-label="Copertura dell’analisi stili">
      <MetricCard label="Partite uniche" value={data.summary.unique_games} detail={`${data.summary.observations} osservazioni account`} />
      <MetricCard label="Partite classificate" value={data.summary.classified_games} detail={`${data.summary.unclassified_games} senza classificazione`} tone="info" />
      <MetricCard label="Con metriche locali" value={data.summary.metrics_games} detail="Copertura dettagliata nei confronti sotto" tone="neutral" />
      <MetricCard label="Categorie supportate" value={data.summary.supported_categories} detail={`${data.summary.accounts} account selezionati`} tone="warning" />
    </section>
    <div className="playstyles-answer" role="status"><strong>{firstSupported ? `Segnale sostenuto: ${firstSupported.label}` : 'Nessun vantaggio confermato in questo contesto'}</strong><p>{firstSupported ? `${liftLabel(firstSupported.lift)} rispetto al riferimento. Controlla la composizione e quanto il risultato dipende dal singolo campione.` : 'Le categorie restano esplorative. Più partite o una percentuale alta, da sole, non confermano un archetipo vincente.'}</p></div>
    <Surface className="playstyles-archetypes" id="playstyle-archetypes">
      <div className="section-heading"><div><p className="eyebrow"><Layers3 aria-hidden="true" /> 01 / Archetipi dei campioni</p><h2>Con quali categorie vinci?</h2></div><StatusBadge tone="info">Tag non esclusivi</StatusBadge></div>
      <p className="section-copy">Confronti fra i campioni osservati {filters.role === 'ALL' ? 'in tutti i ruoli aggregati' : 'nello stesso ruolo'}. Un campione può appartenere a più categorie: i conteggi delle carte non si sommano.</p>
      <FilterBar><label>Cerca categoria<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Classe o stile dettagliato" /></label>
        <label>Ordina categorie<select value={order} onChange={(event) => setOrder(event.target.value)}><option value="support">Supporto e differenza osservata</option><option value="games">Partite osservate</option><option value="name">Nome</option></select></label>
        <span className="filter-count" role="status">{categories.length} {categories.length === 1 ? 'categoria visibile' : 'categorie visibili'} su {data.categories.length}</span>
      </FilterBar>
      {categories.length ? (
        <DataExplorer
          id="playstyle-archetypes"
          label="Archetipi dei campioni"
          metricLabel="Vittorie osservate"
          valueDomain={[0, 100]}
          valueSuffix="%"
          sampleLabel="Partite uniche"
          defaultView="list"
          listLabel="Categorie"
          items={categories.map((item) => ({
            id: item.id,
            label: item.label,
            subtitle: `${kindLabel(item.kind)} · ${item.supported ? 'Segnale supportato' : 'Da esplorare'} · ${item.comparable_accounts}/${item.account_count} account confrontabili${item.missing_accounts.length || item.missing_baseline_accounts.length ? ' · copertura incompleta' : ''}`,
            value: item.mean,
            valueLabel: percentage(item.mean),
            sample: item.games,
            low: interval(item).lower,
            high: interval(item).upper,
            reference: item.baseline_games > 0 ? item.baseline_mean : null,
            tone: item.supported ? 'positive' : 'warning',
            details: <CategoryCard item={item} scope={scope} filters={filters} trainingHref={trainingHref(item.id)} inExplorer />,
          }))}
        >
          <div className="playstyles-category-grid">{categories.map((item) => <CategoryCard key={item.id} item={item} scope={scope} filters={filters} trainingHref={trainingHref(item.id)} />)}</div>
        </DataExplorer>
      ) : <EmptyState title="Nessuna categoria disponibile" description={search ? 'Prova un altro nome: la ricerca cambia solo le carte visibili.' : 'Questa combinazione di account, ruolo, coda e periodo non contiene categorie osservate.'} />}
      <details className="playstyles-catalog"><summary><BookOpen aria-hidden="true" /> Criteri e fonti del catalogo</summary>
        <p>Catalogo {data.catalog.version} · fonte {data.catalog.source_version}. Le categorie descrivono i campioni; non sono etichette assegnate al tuo comportamento.</p>
        <dl>{data.catalog.categories.map((item) => <div key={item.id}><dt>{item.label} <small>{kindLabel(item.kind)}</small></dt><dd>{Array.isArray(item.criteria) ? item.criteria.join(' · ') : item.criteria}<br />Ruoli compatibili: {item.roles.map((role) => roleLabel(role)).join(' · ') || 'Non indicati'}</dd></div>)}</dl>
        <Sources sources={data.catalog.sources} />
      </details>
    </Surface>
    <Surface className="playstyles-suggestions-link">
      <div className="section-heading"><div><p className="eyebrow"><Compass aria-hidden="true" /> Dal segnale alla scelta</p><h2>Campioni da provare</h2></div></div>
      <p className="section-copy">Apri Campioni per esplorare proposte di questa categoria. Qui i risultati sono aggregati nel contesto selezionato; i suggerimenti usano un ruolo operativo e mostrano il proprio contesto effettivo.</p>
      <Link className="button" to={trainingHref(data.suggestions.category_id ?? '')}>Vedi i campioni da provare</Link>
    </Surface>
    <Surface id="playstyle-behavior" className="playstyles-observed">
      <div className="section-heading"><div><p className="eyebrow"><Eye aria-hidden="true" /> 02 / Comportamento osservato</p><h2>Come si presentano le tue vittorie?</h2></div><StatusBadge tone="neutral">Descrittivo</StatusBadge></div>
      <p className="section-copy">Metriche finali delle partite già salvate. Mostrano associazioni con il risultato: non dimostrano che aumentare una metrica faccia vincere.</p>
      <p className="playstyles-method">I percentili confrontano account, campione, ruolo, coda e fascia di durata comparabili. Le celle con poco storico restano senza percentile; 50 indica la posizione centrale nel contesto, non una probabilità di vittoria.</p>
      {data.behavior.length ? <BehaviorRadar items={data.behavior}><div className="playstyles-behavior-grid">{data.behavior.map((item) => <BehaviorCard key={item.id} item={item} />)}</div></BehaviorRadar> : <EmptyState title="Metriche locali non disponibili" description="I dati già salvati non consentono questi confronti nel perimetro selezionato." />}
    </Surface>
    {data.notes.length ? <aside className="playstyles-notes" aria-label="Limiti e copertura"><h2>Come leggere questi risultati</h2><ul>{data.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></aside> : null}
  </>
}

export function playstyleDaysFromSettings(value: unknown): PlaystyleDays {
  const normalized = String(value)
  return normalized === '90' || normalized === '180' || normalized === '365' || normalized === 'all' ? normalized : '180'
}

export function playstyleFiltersFromParams(params: URLSearchParams, defaultDays: PlaystyleDays, defaultQueue = '420'): PlaystyleFilters {
  const rawDays = params.get('days')
  const days = rawDays === '90' || rawDays === '180' || rawDays === '365' || rawDays === 'all' ? rawDays : defaultDays
  return { role: params.get('role') || 'ALL', queue: params.get('queue') || defaultQueue, days, category: params.get('category') || undefined }
}

export function PlaystyleSuggestionsPanel() {
  const { scope, scopeReady } = useScope()
  const { settings } = useAlgorithmSettings()
  const [params] = useSearchParams()
  const defaultDays = playstyleDaysFromSettings(getSetting(settings, 'context.days'))
  const defaultQueue = String(getSetting(settings, 'context.queue') || '420')
  const filters = playstyleFiltersFromParams(params, defaultDays, defaultQueue)
  const result = useQuery({ ...playstylesQuery(scope, filters), enabled: scopeReady && Boolean(filters.category) })
  if (!filters.category) return null
  if (result.isPending) return <Skeleton lines={5} label="Caricamento campioni da provare" />
  if (result.isError) return <ErrorState error={result.error} onRetry={() => void result.refetch()} />
  return result.data ? <Suggestions data={result.data} params={params} /> : null
}

export function PlaystylesPage({ embedded = false }: { embedded?: boolean }) {
  const { scope, scopeReady } = useScope()
  const { settings } = useAlgorithmSettings()
  const [params, setParams] = useSearchParams()
  const defaultDays = playstyleDaysFromSettings(getSetting(settings, 'context.days'))
  const defaultQueue = String(getSetting(settings, 'context.queue') || '420')
  const filters = playstyleFiltersFromParams(params, defaultDays, defaultQueue)
  const days = filters.days
  const result = useQuery({ ...playstylesQuery(scope, filters), enabled: scopeReady })
  const data = result.data
  const selectedRole = filters.role ?? 'ALL'
  const selectedQueue = filters.queue ?? data?.filters.queue ?? 'all'
  const roles = [...new Set(data?.options.roles ?? [])]
  if (selectedRole !== 'ALL' && !roles.includes(selectedRole)) roles.push(selectedRole)
  const queues = [...(data?.options.queues ?? [])]
  if (selectedQueue !== 'all' && !queues.some((queue) => queue.id === selectedQueue)) queues.push({ id: selectedQueue, label: selectedQueue })
  const update = (key: string, value: string) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (value) next.set(key, value)
    else next.delete(key)
    return next
  }, { replace: true })
  const scopeKey = JSON.stringify([scopeQuery(scope), filters])
  const trainingHref = (category: string) => {
    const trainingParams = new URLSearchParams()
    trainingParams.set('section', 'training')
    const activeRole = data?.filters.role ?? filters.role
    const activeQueue = data?.filters.queue ?? filters.queue
    if (activeRole && activeRole !== 'ALL') trainingParams.set('role', activeRole)
    trainingParams.set('queue', activeQueue && activeQueue !== 'all' ? activeQueue : 'all')
    trainingParams.set('days', days)
    if (category) trainingParams.set('category', category)
    return `/app/fit?${trainingParams.toString()}`
  }
  return <div className="page-stack playstyles-page">
    <PageHeader level={embedded ? 2 : 1} eyebrow="Esplorazione / Stili di gioco" title={<>Quali stili <em>funzionano per te?</em></>} copy="Archetipi dei campioni e comportamento osservato: due letture separate delle partite degli account selezionati." />
    <nav className="playstyles-section-links" aria-label="Sezioni stili di gioco"><a href="#playstyle-archetypes">Archetipi</a><a href="#playstyle-behavior">Comportamento osservato</a></nav>
    <FilterBar className="playstyles-context">
      <label>Ruolo degli stili<select value={selectedRole} onChange={(event) => update('role', event.target.value)}><option value="ALL">Tutti i ruoli · aggregato</option>{roles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
      <label>Modalità degli stili<select value={selectedQueue} onChange={(event) => update('queue', event.target.value)}><option value="all">Tutte le modalità · aggregato</option>{queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.label}</option>)}</select></label>
      <label>Periodo degli stili<select value={days} onChange={(event) => update('days', event.target.value === 'all' ? '' : event.target.value)}><option value="90">Ultimi 90 giorni</option><option value="180">Ultimi 180 giorni</option><option value="365">Ultimi 365 giorni</option><option value="all">Tutto lo storico</option></select></label>
    </FilterBar>
    {data ? <p className="playstyles-auto">Contesto analizzato: {roleLabel(data.filters.role)} · {data.filters.queue === 'all' ? 'tutte le modalità · aggregato' : queues.find((queue) => queue.id === data.filters.queue)?.label ?? data.filters.queue} · {data.filters.days === 'all' ? 'tutto lo storico' : `ultimi ${data.filters.days} giorni`}.</p> : null}
    {data && data.summary.observations === 0 ? <EmptyState title="Nessuna partita per questi filtri" description="Scegli un ruolo, una modalità o un periodo con storico disponibile. I filtri espliciti restano invariati e non c’è un vantaggio sostenuto da mostrare." /> : null}
    {result.isPending ? <Skeleton lines={8} label="Analisi degli stili per i filtri attivi" /> : null}
    {result.isError ? <ErrorState error={result.error} onRetry={() => void result.refetch()} /> : null}
    {data ? <Results key={scopeKey} data={data} scope={scope} filters={{ ...filters, role: data.filters.role, queue: data.filters.queue }} trainingHref={trainingHref} /> : null}
  </div>
}
