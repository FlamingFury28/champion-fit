import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ScanSearch, Search } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { recommendationsQuery } from '../api/queries'
import { pct, ROLES } from '../app/filters'
import { preferencePeriodLabel, queueLabel, roleLabel, tagLabel, translateModelText } from '../app/labels'
import { championHref, withParams } from '../app/navigation'
import { recommendationListFilters } from '../app/recommendation-filters'
import { useScope } from '../app/scope'
import { ObservedRecommendationCard } from '../components/ObservedRecommendationCard'
import { DecisionSummary, EmptyState, ErrorState, FilterBar, PageHeader, Skeleton } from '../components/ui'

const roles = ROLES.filter((role) => role !== 'ALL')

export function ScoutPage({ embedded = false }: { embedded?: boolean }) {
  const { scope, scopeReady } = useScope()
  const [params, setParams] = useSearchParams()
  const search = params.get('search') ?? ''
  const tag = params.get('tag') ?? params.get('category') ?? 'ALL'
  const minSimilarity = Math.min(100, Math.max(0, Number(params.get('minSimilarity')) || 0))
  const filters = recommendationListFilters(params, 'training')
  const { role: explicitRole } = filters
  const result = useQuery({ ...recommendationsQuery(scope, filters), enabled: scopeReady })
  const data = result.data
  const suspendedAccounts = Array.isArray(data?.context.suspended_accounts) ? data.context.suspended_accounts.map(String) : []
  const unresolvedAccounts = Array.isArray(data?.context.unresolved_accounts) ? data.context.unresolved_accounts.map(String) : []
  const feedbackAccounts = data?.coverage.selected_accounts.filter((account) => !suspendedAccounts.includes(account) && !unresolvedAccounts.includes(account)) ?? []
  const allowAllAccountsShortcut = scope.accounts.length === 0 && feedbackAccounts.length === (data?.coverage.selected_accounts.length ?? 0)
  const update = (key: string, value: string) => setParams((current) => { const next = new URLSearchParams(current); if (key === 'tag') next.delete('category'); if (!value || value === 'ALL' || value === '0') next.delete(key); else next.set(key, value); return next }, { replace: true })
  const sourceTags = useMemo(() => [...new Set((data?.discover ?? []).flatMap((item) => item.source_champions.flatMap((source) => source.matched_tags)))].slice(0, 30), [data])
  const tagOptions = tag !== 'ALL' && !sourceTags.includes(tag) ? [tag, ...sourceTags] : sourceTags
  const searchNeedle = search.trim().toLocaleLowerCase('it')
  const items = (data?.discover ?? []).filter((item) => {
    const matchesSearch = !searchNeedle || item.name.toLocaleLowerCase('it').includes(searchNeedle) || item.champion.toLocaleLowerCase('it').includes(searchNeedle)
    const matchesTag = tag === 'ALL' || item.source_champions.some((source) => source.matched_tags.includes(tag))
    return matchesSearch && matchesTag && (item.similarity ?? 0) * 100 >= minSimilarity
  })
  const first = items[0]
  const planHref = withParams('/app/fit', new URLSearchParams({ ...Object.fromEntries(params), section: 'training', training: 'plan' }))
  const reset = () => setParams((current) => { const next = new URLSearchParams(current); ['search', 'tag', 'category', 'minSimilarity'].forEach((key) => next.delete(key)); return next }, { replace: true })

  return <div className="page-stack">
    <PageHeader level={embedded ? 2 : 1} eyebrow="Campioni / Da scoprire" title="Scelte vicine ai tuoi gusti" copy="Le proposte condividono caratteristiche con i campioni che hai giocato o indicato. La similarità di catalogo non misura la probabilità di vincere." aside={<Link className="button button--secondary" to={planHref}>{data ? `Piano da ${data.trial_plan.budget} ${data.trial_plan.budget === 1 ? 'prova' : 'prove'}` : 'Vedi il piano di prove'} <ArrowRight aria-hidden="true" /></Link>} />
    <DecisionSummary answer={result.isPending ? 'Sto leggendo le tue preferenze' : result.isError ? 'Non posso caricare le scoperte' : first ? `Potresti provare ${first.name || first.champion} · ${roleLabel(first.role)}` : 'Nessuna scoperta con questi filtri'} detail={first ? `${first.similarity == null ? 'Affinità di catalogo non stimata.' : `${pct(first.similarity * 100, 0)} di affinità di catalogo.`} ${translateModelText(first.reasons[0] ?? 'Condivide caratteristiche con le tue scelte osservate.')}` : result.isPending ? 'Uso partite e preferenze dichiarate nel perimetro selezionato.' : result.isError ? 'Riprova mantenendo lo stesso contesto.' : 'Azzera i filtri locali; ruolo, coda e periodo restano invariati.'} status={first ? first.similarity == null ? 'Affinità non stimata' : 'Ipotesi di affinità' : result.isError ? 'Errore temporaneo' : 'Contesto corrente'} tone={result.isError ? 'negative' : first ? 'info' : 'warning'} />
    <FilterBar>
      <label className="search-field">Campione<span><Search aria-hidden="true" /><input value={search} onChange={(event) => update('search', event.target.value)} placeholder="Cerca" /></span></label>
      <label>Ruolo<select value={explicitRole ?? ''} onChange={(event) => update('role', event.target.value)}>{explicitRole === 'AUTO' ? <option value="AUTO" disabled>Ruolo automatico</option> : null}<option value="">Tutti i ruoli · nessun filtro</option>{roles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
      <label>Caratteristica<select value={tag} onChange={(event) => update('tag', event.target.value)}><option value="ALL">Tutte</option>{tagOptions.map((value) => <option key={value} value={value}>{tagLabel(value.includes(':') ? value.slice(value.indexOf(':') + 1) : value)}</option>)}</select></label>
      <label>Affinità minima · {minSimilarity}%<input type="range" min={0} max={100} step={5} value={minSimilarity} onChange={(event) => update('minSimilarity', event.target.value)} /></label>
      <span className="filter-count">{items.length} proposte</span>
    </FilterBar>
    {result.isPending ? <Skeleton lines={9} label="Caricamento delle scoperte" /> : null}
    {result.isError ? <ErrorState title="Scoperte non disponibili" error={result.error} onRetry={() => void result.refetch()} /> : null}
    {data ? items.length ? <>
      <div className="answer-ranking">{items.map((item, index) => <ObservedRecommendationCard key={`${item.champion}-${item.role}`} item={item} index={index} detailHref={championHref(item.champion, item.role, params, { queue: data.context.queue })} feedbackAccounts={feedbackAccounts} allowAllAccountsShortcut={allowAllAccountsShortcut} feedbackRevision={data.feedback_revision} />)}</div>
      <p className="context-note">Contesto effettivo: {roleLabel(data.context.role)} · {queueLabel(data.context.queue)} · {preferencePeriodLabel(data.context.period, data.context.days)}. Le proposte senza partite personali non mostrano stime di vittoria.</p>
    </> : <EmptyState title="Nessuna scoperta per questi filtri" description="I filtri espliciti non vengono ampliati automaticamente." action={<button className="button button--secondary" type="button" onClick={reset}><ScanSearch aria-hidden="true" /> Azzera ricerca e affinità</button>} /> : null}
  </div>
}
