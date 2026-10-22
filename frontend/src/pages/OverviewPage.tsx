import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BarChart3, Database, History, Info, RotateCcw, Target } from 'lucide-react'
import { Link } from 'react-router'
import { championsQuery, syncStatusQuery, trainingPlanQuery } from '../api/queries'
import type { ChampionListItemDto, TrainingPlanResponseDto } from '../api/types'
import { credibleMassLabel } from '../app/algorithm-settings'
import { pct, ROLES } from '../app/filters'
import { preferencePeriodLabel, queueLabel, roleLabel } from '../app/labels'
import { championHref, destinations, withParams } from '../app/navigation'
import { useOverviewBudget } from '../app/overview-budget'
import { OVERVIEW_PERIODS, OVERVIEW_QUEUES, useOverviewFilters } from '../app/overview-filters'
import { useScope } from '../app/scope'
import { ChampionAvatar, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, Surface } from '../components/ui'
import './OverviewPage.css'

function count(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('it-IT') : '—'
}

function contextParams(section: string, context?: Record<string, unknown>) {
  const params = new URLSearchParams({ section })
  for (const key of ['role', 'queue', 'days'] as const) {
    const value = context?.[key]
    if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) {
      params.set(key, String(value))
    }
  }
  return params
}

function ContextLabel({ context }: { context?: Record<string, unknown> }) {
  if (!context) return <span>Contesto in attesa dei dati</span>
  return <span>{roleLabel(String(context.role ?? ''))} · {queueLabel(String(context.queue ?? ''))} · {preferencePeriodLabel(undefined, context.days)}</span>
}

function DataUpdatedAt() {
  const sync = useQuery(syncStatusQuery)
  const value = sync.data?.last_completed_at
  const parsed = value ? new Date(value) : null
  const date = parsed && Number.isFinite(parsed.getTime()) ? parsed : null
  return <span className="overview-context__updated" title="Ultimo aggiornamento dell’intero archivio, indipendente dai filtri selezionati. Data e ora locali.">
    Ultimo aggiornamento dati: {sync.isPending ? 'verifica…' : sync.isError || !date ? 'non disponibile' : <time dateTime={date.toISOString()}>{date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' })}</time>}
    {!sync.isError && sync.data?.sync_active ? ' · aggiornamento in corso' : null}
  </span>
}

function Candidate({ item, params }: { item: ChampionListItemDto; params: URLSearchParams }) {
  const lower = item.credible_lower_90
  const upper = item.credible_upper_90
  const estimate = item.posterior_win_rate
  const hasInterval = typeof lower === 'number' && typeof upper === 'number' && typeof estimate === 'number'
    && [lower, upper, estimate].every(Number.isFinite) && lower >= 0 && upper <= 100 && lower <= estimate && estimate <= upper
  const mass = item.credible_mass
  const intervalLabel = typeof mass === 'number' && Number.isFinite(mass) && mass > 0 && mass < 1
    ? `Intervallo ${credibleMassLabel(mass)}` : 'Intervallo'
  const signal = item.historical_supported
    ? { text: 'Vantaggio storico supportato', tone: 'warning' as const }
    : item.classification === 'promising'
      ? { text: 'Positivo da verificare', tone: 'info' as const }
      : { text: 'Nessun segnale positivo', tone: 'neutral' as const }

  return <li>
    <article className="overview-candidate">
      <div className="overview-candidate__identity">
        <ChampionAvatar name={item.champion} src={item.icon_url} size="lg" />
        <div><h3><Link to={championHref(item.champion, item.role, params)} aria-label={`Apri la scheda di ${item.champion}, ${roleLabel(item.role)}`}>{item.champion}</Link></h3><span>{roleLabel(item.role, true)} · {count(item.unique_games)} {item.unique_games === 1 ? 'partita unica' : 'partite uniche'}</span></div>
      </div>
      <div className="overview-candidate__estimate"><span>Stima aggiustata</span><strong>{pct(estimate)}</strong></div>
      <div className="overview-candidate__evidence">
        <StatusBadge tone={signal.tone}>{signal.text}</StatusBadge>
        <span>{intervalLabel}: {hasInterval ? `${pct(lower)}–${pct(upper)}` : 'non disponibile'}</span>
      </div>
      {hasInterval ? <div className="overview-interval" aria-hidden="true">
        <span className="overview-interval__range" style={{ left: `${lower}%`, width: `${upper - lower}%` }} />
        <span className="overview-interval__estimate" style={{ left: `${estimate}%` }} />
      </div> : null}
      <ArrowRight className="overview-candidate__arrow" aria-hidden="true" />
    </article>
  </li>
}

function PlanPreview({ data }: { data: TrainingPlanResponseDto }) {
  const assigned = data.items.filter((item) => item.allocation_games > 0)
    .sort((left, right) => right.allocation_games - left.allocation_games || left.champion.localeCompare(right.champion, 'it') || left.role.localeCompare(right.role))
  const unassigned = data.budget_unassigned ?? Math.max(0, data.budget_total - data.budget_assigned)

  return <>
    {assigned.length ? <>
      <ul className="overview-plan__list" aria-label="Anteprima delle partite assegnate">{assigned.slice(0, 3).map((item) => <li key={`${item.champion}-${item.role}`}>
        <ChampionAvatar name={item.champion} src={item.icon_url} size="sm" />
        <div><strong>{item.champion}</strong><span>{roleLabel(item.role, true)}</span></div>
        <span className="overview-plan__games"><strong>{count(item.allocation_games)}</strong> {item.allocation_games === 1 ? 'partita' : 'partite'}</span>
      </li>)}</ul>
      {assigned.length > 3 ? <p className="overview-note">Altre {assigned.length - 3} coppie campione/ruolo nel piano completo.</p> : null}
    </> : <p className="overview-note">Nessuna partita assegnata: il contesto attuale non offre candidati per il piano.</p>}
    {unassigned > 0 ? <p className="overview-note">{count(unassigned)} {unassigned === 1 ? 'partita ancora da assegnare' : 'partite ancora da assegnare'}.</p> : null}
    <p className="overview-note">Il piano distribuisce le prove per ridurre l’incertezza. Non indica l’ordine in cui giocare e non garantisce più vittorie.</p>
  </>
}

export function OverviewPage() {
  const { scope, scopeReady } = useScope()
  const budgetControl = useOverviewBudget()
  const { filters, storageAvailable, updateFilters, resetFilters } = useOverviewFilters(budgetControl.budget)
  const planBudget = budgetControl.budget
  const role = filters.role || undefined
  const analysisFilters = { queue: filters.queue || undefined, days: filters.days || undefined }
  const ranking = useQuery({ ...championsQuery(scope, { ...analysisFilters, role, status: 'ALL', search: '' }), enabled: scopeReady })
  const plan = useQuery({ ...trainingPlanQuery(scope, planBudget, role, analysisFilters), enabled: scopeReady })
  const data = ranking.data
  const items = data?.items ?? []
  const context = data?.context
  const comparisonParams = contextParams('best', context ?? filters)
  const planParams = contextParams('tournament', plan.data?.context ?? filters)
  planParams.set('budget', String(plan.data?.budget_total ?? planBudget))
  const comparisonHref = withParams(destinations.champions, comparisonParams)
  const planHref = withParams(destinations.champions, planParams)
  const supported = items.some((item) => item.historical_supported)
  const headline = items.length === 1 ? 'Un primo punto di partenza.'
    : supported ? 'Lo storico offre segnali da approfondire.' : 'La scelta è ancora aperta.'

  return <div className="page-stack overview-page">
    <PageHeader eyebrow="Prima della prossima sessione" title="Riepilogo" copy="Il punto sui tuoi campioni e sulle prossime partite da dedicare al confronto." aside={ranking.isFetching && data ? <StatusBadge tone="info">Aggiornamento dei risultati</StatusBadge> : undefined} />

    <section className="overview-context" aria-label="Dati del riepilogo">
      <div className="overview-context__summary">
      <Database aria-hidden="true" />
      <div className="overview-context__scope"><strong>{scope.accounts.length ? scope.accounts.join(', ') : 'Tutti gli account attivi'}</strong>
        <ContextLabel context={context} />
        {scope.companion ? <span>{scope.companion.mode === 'only' ? 'Solo con' : 'Escludendo'} {scope.companion.name}</span> : null}
        <DataUpdatedAt />
      </div>
      <div className="overview-context__count"><strong>{count(context?.unique_games)}</strong><span>{context?.unique_games === 1 ? 'partita unica' : 'partite uniche'}</span></div>
      <Link className="text-link" to={destinations.data}>Dati usati <ArrowRight aria-hidden="true" /></Link>
      </div>
      <div className="overview-filters" role="group" aria-label="Filtri del riepilogo">
        <label>Ruolo<select value={filters.role} onChange={(event) => updateFilters({ role: event.target.value })}>
          {filters.role && !ROLES.includes(filters.role as typeof ROLES[number]) ? <option value={filters.role} disabled>Ruolo del link: {filters.role}</option> : null}
          <option value="">Automatico</option>{ROLES.map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}
        </select></label>
        <label>Modalità<select value={filters.queue} onChange={(event) => updateFilters({ queue: event.target.value })}>
          {filters.queue && !['all', ...OVERVIEW_QUEUES].includes(filters.queue) ? <option value={filters.queue} disabled>Modalità del link: {filters.queue}</option> : null}
          <option value="">Predefinita</option><option value="all">Tutte le modalità</option>{OVERVIEW_QUEUES.map((value) => <option key={value} value={value}>{queueLabel(value)}</option>)}
        </select></label>
        <label>Periodo<select value={filters.days} onChange={(event) => updateFilters({ days: event.target.value })}>
          {filters.days && !OVERVIEW_PERIODS.includes(filters.days) ? <option value={filters.days} disabled>Periodo del link: {filters.days}</option> : null}
          <option value="">Predefinito</option>{OVERVIEW_PERIODS.map((value) => <option key={value} value={value}>{value === 'all' ? 'Tutto lo storico' : `${value} giorni`}</option>)}
        </select></label>
        <button type="button" className="button button--ghost button--compact" onClick={resetFilters} disabled={!filters.role && !filters.queue && !filters.days} aria-label="Ripristina filtri predefiniti"><RotateCcw aria-hidden="true" /><span>Ripristina</span></button>
      </div>
      {!storageAvailable ? <p className="overview-filters__notice" role="status">Filtri attivi per questa visita. Il browser non consente di ricordarli alla prossima apertura.</p> : null}
    </section>

    <div className="overview-workspace">
      <Surface className="overview-ranking" aria-label="Rendimento storico dei campioni">
        <div className="overview-section-heading"><p className="eyebrow"><BarChart3 aria-hidden="true" /> Rendimento storico</p>
          {data ? <StatusBadge tone={data.model?.validated ? 'positive' : 'warning'}>{data.model?.validated ? 'Validazione temporale superata' : 'Analisi esplorativa'}</StatusBadge> : null}
        </div>
        {ranking.isPending ? <><h2 id="overview-ranking-title">Quali campioni emergono?</h2><Skeleton lines={6} label="Caricamento del riepilogo dei campioni" /></> : null}
        {ranking.isError ? <ErrorState title={data ? 'Risultati non aggiornati' : 'Riepilogo dei campioni non disponibile'} error={ranking.error} onRetry={() => void ranking.refetch()} /> : null}
        {data && items.length ? <>
          <h2 id="overview-ranking-title">{headline}</h2>
          <p className="overview-intro">{items.length === 1 ? 'Hai dati per una sola coppia campione/ruolo. Servono altri candidati per un confronto.'
            : supported ? 'Alcuni campioni mostrano un vantaggio rispetto al riferimento storico. Questo non stabilisce un vincitore tra loro.'
              : 'Nessun vantaggio storico supportato nel contesto attuale. Parti da queste stime e confronta la loro incertezza.'}</p>
          <div className="overview-ranking__caption"><h3>Campioni da confrontare</h3><span>{Math.min(3, items.length)} di {count(items.length)} {items.length === 1 ? 'coppia' : 'coppie'} campione/ruolo</span></div>
          <ul className="overview-candidates" aria-label="Campioni da confrontare">{items.slice(0, 3).map((item) => <Candidate key={`${item.champion}-${item.role}`} item={item} params={comparisonParams} />)}</ul>
          <div className="overview-scale" aria-hidden="true"><span>0%</span><span>Punto: stima · segmento: intervallo</span><span>100%</span></div>
          <p className="overview-note">L’ordine segue il rendimento storico. La prima posizione non dimostra una superiorità sugli altri campioni.</p>
        </> : data ? <><h2 id="overview-ranking-title">Il confronto parte dai tuoi dati.</h2><EmptyState title="Nessun campione nel contesto attuale" description="Controlla gli account e i compagni selezionati, oppure amplia ruolo, modalità e periodo dai filtri qui sopra." /></> : null}
        <Link className="button overview-ranking__action" to={comparisonHref}>Confronta i campioni <ArrowRight aria-hidden="true" /></Link>
      </Surface>

      <Surface className="overview-plan" aria-labelledby="overview-plan-title">
        <p className="eyebrow"><Target aria-hidden="true" /> Prossimo passo</p>
        <h2 id="overview-plan-title">Un piano per fare chiarezza.</h2>
        <p className="overview-intro">Dedica le prossime partite ai candidati del piano competitivo.</p>
        <div className="overview-plan__budget">
          <label>Partite del piano<input type="number" min={20} max={2000} step={1} inputMode="numeric" value={budgetControl.value}
            aria-describedby="overview-budget-help" onChange={(event) => budgetControl.setValue(event.target.value)} onBlur={budgetControl.commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); budgetControl.commit() }
              if (event.key === 'Escape') { event.preventDefault(); budgetControl.reset() }
            }} /></label>
          <div className="overview-plan__allocation" role="status"><strong>{count(plan.data?.budget_assigned)}</strong><span>partite distribuite</span></div>
          <p id="overview-budget-help">20–2000 · Invio o uscita dal campo per aggiornare. {budgetControl.storageAvailable ? 'Il budget viene ricordato anche nel piano competitivo.' : 'Il browser non può ricordare il budget: conserva il link.'}</p>
        </div>
        {plan.isPending ? <Skeleton lines={5} label="Calcolo dell’anteprima del piano" /> : null}
        {plan.isError ? <ErrorState title={plan.data ? 'Piano non aggiornato' : 'Piano non disponibile'} error={plan.error} onRetry={() => void plan.refetch()} /> : null}
        {plan.data ? <>
          <div className="overview-plan__status"><StatusBadge tone={plan.data.model?.validated ? 'positive' : 'warning'}>{plan.data.model?.validated ? 'Validazione temporale superata' : 'Piano esplorativo'}</StatusBadge>{plan.isFetching ? <StatusBadge tone="info">Ricalcolo</StatusBadge> : null}</div>
          <PlanPreview data={plan.data} />
          <p className="overview-note overview-plan__context"><ContextLabel context={plan.data.context} /></p>
        </> : null}
        <Link className="button button--secondary overview-plan__action" to={planHref}>Apri il piano <ArrowRight aria-hidden="true" /></Link>
      </Surface>
    </div>

    <div className="overview-footer">
      <details className="overview-method"><summary><Info aria-hidden="true" /> Come leggere questi risultati</summary>
        <p>Le stime descrivono i risultati storici, tenendo conto del contesto e degli account. Un intervallo ampio indica maggiore incertezza; il numero di partite va letto insieme alla stima.</p>
        <p>{data?.model?.message ?? 'Il modello resta esplorativo finché non supera la validazione temporale.'} Il vantaggio storico è un confronto con il riferimento, non una prova che un campione sia migliore di tutti gli altri né una previsione della prossima partita.</p>
      </details>
      <Link className="overview-history" to={destinations.matches}><History aria-hidden="true" /><span><strong>Riparti dalle tue partite</strong><span>Consulta gli esiti e le annotazioni nello storico.</span></span><ArrowRight aria-hidden="true" /></Link>
    </div>
  </div>
}
