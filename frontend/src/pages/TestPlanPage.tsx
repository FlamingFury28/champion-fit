import { useQuery } from '@tanstack/react-query'
import { ArrowRight, FlaskConical } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { recommendationsQuery } from '../api/queries'
import { normalizeRole, ROLES } from '../app/filters'
import { preferencePeriodLabel, queueLabel, roleLabel, translateModelText } from '../app/labels'
import { championHref, withParams } from '../app/navigation'
import { useScope } from '../app/scope'
import { ChampionAvatar, DataTable, DecisionSummary, EmptyState, ErrorState, FilterBar, MetricCard, PageHeader, QueryResults, Skeleton, StatusBadge, Surface } from '../components/ui'

const roles = ROLES.filter((role) => role !== 'ALL')
const concreteRole = (value: string | null) => { const role = normalizeRole(value); return role === 'ALL' ? undefined : role }

export function TestPlanPage({ embedded = false }: { embedded?: boolean }) {
  const { scope, scopeReady } = useScope()
  const [params, setParams] = useSearchParams()
  const explicitRole = concreteRole(params.get('role'))
  const queue = params.get('queue') ?? undefined
  const days = params.get('days') ?? undefined
  const result = useQuery({ ...recommendationsQuery(scope, { role: explicitRole, queue, days }), enabled: scopeReady })
  const data = result.data
  const update = (key: string, value: string) => setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); return next }, { replace: true })
  const discoverHref = withParams('/app/fit', new URLSearchParams({ ...Object.fromEntries(params), section: 'training', training: 'discover' }))
  const detailFor = (champion: string, role: string) => [...(data?.known ?? []), ...(data?.discover ?? [])].find((item) => item.champion === champion && item.role === role)
  const first = data?.trial_plan.items[0]

  return <div className="page-stack">
    <PageHeader level={embedded ? 2 : 1} eyebrow="Campioni / Piano di prove" title={data ? `${data.trial_plan.budget} ${data.trial_plan.budget === 1 ? 'prova' : 'prove'}, una partita ciascuna` : 'Prossimo ciclo di prove'} copy="Un ciclo breve per trasformare le affinità in esperienza reale. Ogni candidato riceve una partita: il piano non tenta di prevederne l’esito." />
    <DecisionSummary answer={result.isPending ? 'Sto preparando il prossimo ciclo' : result.isError ? 'Il piano non è disponibile' : first ? `Inizia da ${first.champion} · ${roleLabel(first.role)}` : 'Nessuna prova nel contesto corrente'} detail={first ? translateModelText(first.reason) : result.isError ? 'Riprova senza cambiare il perimetro.' : 'Ruolo, coda e periodo espliciti non vengono ampliati automaticamente.'} status={first ? '1 partita' : 'Ciclo corrente'} tone={result.isError ? 'negative' : first ? 'info' : 'warning'} />
    <FilterBar>
      <div className="filter-bar__intro"><strong>Contesto del ciclo</strong><span>Il budget arriva dalle impostazioni del nuovo motore, da 1 a 10 partite.</span></div>
      <label>Ruolo<select value={explicitRole ?? ''} onChange={(event) => update('role', event.target.value)}><option value="">Tutti i ruoli · nessun filtro</option>{roles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
      <span className="filter-count">{data ? `${queueLabel(data.context.queue)} · ${preferencePeriodLabel(data.context.period, data.context.days)}` : 'Contesto in caricamento'}</span>
    </FilterBar>
    {result.isPending ? <Skeleton lines={7} label="Caricamento del piano di prove" /> : null}
    {result.isError ? <ErrorState title="Piano non disponibile" error={result.error} onRetry={() => void result.refetch()} /> : null}
    {data ? <QueryResults label="Piano di prove">
      {data.trial_plan.items.length ? <>
        <section className="metric-grid metric-grid--three"><MetricCard label="Partite nel ciclo" value={data.trial_plan.budget} /><MetricCard label="Candidati" value={data.trial_plan.items.length} tone="info" /><MetricCard label="Partite per candidato" value="1" tone="warning" /></section>
        <Surface><div className="section-heading"><div><p className="eyebrow">Metodo</p><h2>Prove piccole e leggibili</h2></div><StatusBadge tone="info">Nessuna stima preventiva</StatusBadge></div><p className="section-copy">Il piano combina gusti osservati, preferenze dichiarate e somiglianze di catalogo. Dopo ogni partita i risultati reali entrano nel profilo; una singola vittoria o sconfitta resta un dato iniziale.</p></Surface>
        <DataTable label="Prossime partite da provare"><thead><tr><th>Campione</th><th>Ruolo</th><th>Partite</th><th>Perché</th><th>Dettaglio</th></tr></thead><tbody>{data.trial_plan.items.map((item) => { const detail = detailFor(item.champion, item.role); return <tr key={`${item.champion}-${item.role}`}><th scope="row"><span className="champion-link"><ChampionAvatar name={detail?.name || item.champion} src={detail?.icon_url} size="sm" /><span>{detail?.name || item.champion}</span></span></th><td>{roleLabel(item.role)}</td><td className="numeric numeric--hero">{item.games}</td><td>{translateModelText(item.reason)}</td><td><Link className="text-link" state={{ championSheetFromList: true }} to={championHref(item.champion, item.role, params)}>Apri <ArrowRight aria-hidden="true" /></Link></td></tr> })}</tbody></DataTable>
        <div className="info-callout"><FlaskConical aria-hidden="true" /><div><strong>Vuoi confrontare tutte le affinità?</strong><p><Link className="text-link" to={discoverHref}>Apri i campioni da scoprire <ArrowRight aria-hidden="true" /></Link></p></div></div>
      </> : <EmptyState title="Nessuna prova nel contesto corrente" description="Non ci sono candidati coerenti con i filtri espliciti. Il server non allarga automaticamente ruolo, coda o periodo." />}
    </QueryResults> : null}
  </div>
}
