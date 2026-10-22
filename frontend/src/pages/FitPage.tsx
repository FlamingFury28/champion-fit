import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { recommendationsQuery } from '../api/queries'
import type { ObservedRecommendationDto } from '../api/types'
import { ROLES, useDebouncedValue } from '../app/filters'
import { preferencePeriodLabel, queueLabel, roleLabel } from '../app/labels'
import { championHref } from '../app/navigation'
import { recommendationListFilters } from '../app/recommendation-filters'
import { useScope } from '../app/scope'
import { ObservedRecommendationCard } from '../components/ObservedRecommendationCard'
import { PreferenceEditor } from '../components/PreferenceEditor'
import { EmptyState, ErrorState, FilterBar, PageHeader, QueryResults, Skeleton, StatusBadge, Surface } from '../components/ui'

const recommendationRoles = ROLES.filter((role) => role !== 'ALL')
const recommendationQueues = ['420', '440', '400', '430', '490', '480', '700']
const recommendationPeriods = ['90', '180', '365']

function periodStatus(period: unknown, days: unknown) {
  const label = preferencePeriodLabel(period, days)
  return label.charAt(0).toLocaleUpperCase('it') + label.slice(1)
}

function recommendationMatches(item: ObservedRecommendationDto, search: string) {
  const needle = search.trim().toLocaleLowerCase('it')
  return !needle || item.champion.toLocaleLowerCase('it').includes(needle) || item.name.toLocaleLowerCase('it').includes(needle)
}

export function FitPage() {
  const { scope, scopeReady } = useScope()
  const [params, setParams] = useSearchParams()
  const filters = recommendationListFilters(params, 'choices')
  const { role: explicitRole, queue, days } = filters
  const hasQueueOption = queue === undefined || queue === 'all' || queue === 'auto' || recommendationQueues.includes(queue)
  const hasPeriodOption = days === undefined || days === 'all' || recommendationPeriods.includes(days)
  const search = params.get('search') ?? ''
  const debouncedSearch = useDebouncedValue(search)
  const view = params.get('view') === 'discover' ? 'discover' : 'known'
  const result = useQuery({ ...recommendationsQuery(scope, filters), enabled: scopeReady })
  const data = result.data
  const suspendedAccounts = Array.isArray(data?.context.suspended_accounts) ? data.context.suspended_accounts.map(String) : []
  const unresolvedAccounts = Array.isArray(data?.context.unresolved_accounts) ? data.context.unresolved_accounts.map(String) : []
  const feedbackAccounts = data?.coverage.selected_accounts.filter((account) => !suspendedAccounts.includes(account) && !unresolvedAccounts.includes(account)) ?? []
  const allowAllAccountsShortcut = scope.accounts.length === 0 && feedbackAccounts.length === (data?.coverage.selected_accounts.length ?? 0)
  const items = (view === 'known' ? data?.known : data?.discover)?.filter((item) => recommendationMatches(item, debouncedSearch)) ?? []
  const update = (key: string, value: string) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (value) next.set(key, value)
    else next.delete(key)
    return next
  }, { replace: true })

  return <div className="page-stack">
    <PageHeader level={2} eyebrow="Campioni / Le mie scelte" title={<>Gusti e <em>risultati</em></>} copy="L’ordine parte dalle scelte osservate e dalle preferenze dichiarate; i risultati sono mostrati separatamente. Le scoperte usano somiglianze di catalogo: l’affinità non è una probabilità di vittoria." aside={result.isFetching && data ? <StatusBadge tone="info">Aggiornamento</StatusBadge> : undefined} />

    <PreferenceEditor scope={scope} enabled={scopeReady} />

    <nav className="context-navigation" aria-label="Tipo di suggerimento">
      <button type="button" aria-current={view === 'known' ? 'page' : undefined} onClick={() => update('view', '')}>Familiari e preferiti{data ? ` · ${data.known.length} mostrate` : ''}</button>
      <button type="button" aria-current={view === 'discover' ? 'page' : undefined} onClick={() => update('view', 'discover')}>Da scoprire{data ? ` · ${data.discover.length} mostrate` : ''}</button>
      <Link to="/app/matches?section=style">Quale stile mi conviene?</Link>
    </nav>

    <FilterBar>
      <div className="filter-bar__intro"><strong>Contesto dei suggerimenti</strong><span>I filtri espliciti non vengono allargati quando non trovano partite.</span></div>
      <label>Ruolo<select value={explicitRole ?? ''} onChange={(event) => update('role', event.target.value)}>{explicitRole === 'AUTO' ? <option value="AUTO" disabled>Ruolo automatico</option> : null}<option value="">Tutti i ruoli · nessun filtro</option>{recommendationRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
      <label>Coda<select value={queue ?? ''} onChange={(event) => update('queue', event.target.value)}>{!hasQueueOption ? <option value={queue} disabled>Coda del link</option> : null}{queue === 'auto' ? <option value="auto" disabled>Coda automatica</option> : null}<option value="">Predefinita</option><option value="all">Tutte le code</option>{recommendationQueues.map((value) => <option key={value} value={value}>{queueLabel(value)}</option>)}</select></label>
      <label>Periodo<select value={days ?? ''} onChange={(event) => update('days', event.target.value)}>{!hasPeriodOption ? <option value={days} disabled>Periodo del link</option> : null}<option value="">Predefinito</option>{recommendationPeriods.map((value) => <option key={value} value={value}>{value} giorni</option>)}<option value="all">Tutto lo storico</option></select></label>
      <label className="search-field">Cerca<span><Search aria-hidden="true" /><input value={search} onChange={(event) => update('search', event.target.value)} placeholder="es. Orianna" /></span></label>
      <span className="filter-count" role="status">{result.isFetching && !result.isPending ? 'Aggiornamento…' : `${items.length} ${view === 'known' ? 'scelte' : 'scoperte'}`}</span>
    </FilterBar>

    {result.isPending ? <Skeleton lines={8} label="Caricamento dei suggerimenti" /> : null}
    {result.isError ? <ErrorState title="Suggerimenti non disponibili" error={result.error} onRetry={() => void result.refetch()} /> : null}
    {data ? <>
      <Surface><div className="section-heading"><div><p className="eyebrow">Contesto effettivo</p><h2>{roleLabel(data.context.role)} · {queueLabel(data.context.queue)}</h2></div><StatusBadge tone="neutral">{periodStatus(data.context.period, data.context.days)}</StatusBadge></div><p className="section-copy">{data.coverage.games} partite uniche e {data.coverage.observations} osservazioni su {data.coverage.active_accounts.length} account attivi. Le preferenze dichiarate cambiano l’ordine, non i conteggi delle vittorie e delle sconfitte.</p>{data.coverage.missing_accounts.length ? <p className="context-note">Senza dati nel contesto: {data.coverage.missing_accounts.join(', ')}.</p> : null}</Surface>
      {data.profile.length ? <div className="tag-list" aria-label="Preferenze osservate">{data.profile.slice(0, 10).map((item) => <span key={item.tag}>{item.label} · {item.games} partite</span>)}</div> : null}
      <QueryResults label={view === 'known' ? 'Scelte familiari e preferite' : 'Campioni da scoprire'} aria-busy={result.isFetching}>
        {items.length ? <div className="answer-ranking">{items.map((item, index) => <ObservedRecommendationCard key={`${item.champion}-${item.role}`} item={item} index={index} detailHref={championHref(item.champion, item.role, params, { queue: data.context.queue })} feedbackAccounts={feedbackAccounts} allowAllAccountsShortcut={allowAllAccountsShortcut} feedbackRevision={data.feedback_revision} />)}</div> : <EmptyState title={view === 'known' ? 'Nessuna scelta già giocata o dichiarata' : 'Nessuna scoperta in questo contesto'} description={search ? 'Rimuovi la ricerca per vedere tutte le proposte restituite.' : 'Il perimetro esplicito resta invariato. Cambia un filtro solo se vuoi analizzare un altro contesto.'} />}
      </QueryResults>
      {data.notes.length ? <aside className="context-note"><strong>Come leggere i suggerimenti</strong><ul>{data.notes.map((note, index) => <li key={`${note}-${index}`}>{note}</li>)}</ul></aside> : null}
    </> : null}
  </div>
}
