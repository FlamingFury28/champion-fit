import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { recommendationsQuery } from '../api/queries'
import type { ObservedRecommendationDto } from '../api/types'
import { pct, ROLES } from '../app/filters'
import { preferencePeriodLabel, queueLabel, roleLabel } from '../app/labels'
import { recommendationPeriodFilter, recommendationQueueFilter, recommendationRoleFilter } from '../app/recommendation-filters'
import { useScope } from '../app/scope'
import { ChampionArtwork } from '../components/ChampionArtwork'
import { ObservedRecommendationCard } from '../components/ObservedRecommendationCard'
import { DataTable, DecisionSummary, EmptyState, ErrorState, MetricCard, PageHeader, QueryResults, Skeleton, StatusBadge, Surface } from '../components/ui'

export interface ChampionDetailPageProps { champion?: string; embedded?: boolean }
const roles = ROLES.filter((role) => role !== 'ALL')

function candidateFromResponse(champion: string, role: string | undefined, candidate: ObservedRecommendationDto | null | undefined, known: ObservedRecommendationDto[], discover: ObservedRecommendationDto[]) {
  if (candidate) return candidate
  const candidates = [...known, ...discover].filter((item) => item.champion.toLocaleLowerCase('it') === champion.toLocaleLowerCase('it'))
  return candidates.find((item) => !role || item.role === role) ?? null
}

function perAccountRows(value: NonNullable<ObservedRecommendationDto['performance']>['per_account'] | undefined): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value
  return Object.entries(value ?? {}).map(([account, details]) => ({ account, ...(details && typeof details === 'object' ? details : {}) }) as Record<string, unknown>)
}

interface CandidateDetailsProps {
  candidate: ObservedRecommendationDto
  feedbackAccounts: string[]
  allowAllAccountsShortcut: boolean
  feedbackRevision: number
  isFetching: boolean
  contextNote: string
  identifyRole?: boolean
}

function CandidateDetails({ candidate, feedbackAccounts, allowAllAccountsShortcut, feedbackRevision, isFetching, contextNote, identifyRole = false }: CandidateDetailsProps) {
  const performance = candidate.performance
  const observed = Boolean(performance && performance.games > 0)
  const accountRows = perAccountRows(performance?.per_account)
  const comparableAccountCount = performance?.comparable_accounts.length ?? 0
  const declared = candidate.feedback === 'like'
  const answer = candidate.kind === 'familiar'
    ? observed ? `${candidate.name || candidate.champion} fa già parte delle tue scelte giocate` : declared ? `${candidate.name || candidate.champion} è una preferenza dichiarata` : `${candidate.name || candidate.champion} è già presente nello storico selezionato`
    : candidate.similarity == null ? `${candidate.name || candidate.champion} è una scoperta da valutare` : `${candidate.name || candidate.champion} è una scoperta vicina ai tuoi gusti`
  const detail = observed
    ? `${performance!.wins} ${performance!.wins === 1 ? 'vittoria' : 'vittorie'} e ${performance!.losses} ${performance!.losses === 1 ? 'sconfitta' : 'sconfitte'} in ${performance!.observations} ${performance!.observations === 1 ? 'osservazione account-partita' : 'osservazioni account-partita'}, da ${performance!.games} ${performance!.games === 1 ? 'partita unica' : 'partite uniche'}. È un risultato osservato, non una promessa sulla prossima partita.`
    : declared ? 'Ti piace questo campione, anche se non ci sono partite nel contesto corrente. La preferenza non viene trasformata in una stima di vittoria.' : candidate.kind === 'familiar' ? 'Hai già giocato questo campione in un altro contesto. Qui non ci sono partite: il filtro resta invariato e il campione non viene presentato come mai provato.' : candidate.similarity == null ? 'Affinità di catalogo non stimata. Non viene sostituita con zero o con una probabilità personale.' : `${pct(candidate.similarity * 100, 0)} di affinità di catalogo. Non è una probabilità di vittoria personale.`

  return <section className="page-stack" aria-label={`${candidate.name || candidate.champion} · ${roleLabel(candidate.role)}`}>
    {identifyRole ? <div className="section-heading"><div><p className="eyebrow">Variante per ruolo</p><h2>{roleLabel(candidate.role)}</h2></div><StatusBadge tone="neutral">Metriche separate</StatusBadge></div> : null}
    <DecisionSummary answer={answer} detail={detail} status={candidate.kind === 'familiar' ? observed ? 'Già giocato' : declared ? 'Preferenza dichiarata' : 'Già giocato altrove' : candidate.similarity == null ? 'Affinità non stimata' : 'Affinità da provare'} tone={candidate.kind === 'familiar' ? 'positive' : 'info'} />
    <QueryResults label={`Scheda di ${candidate.name || candidate.champion} · ${roleLabel(candidate.role)}`} aria-busy={isFetching}>
      <section className="metric-grid metric-grid--three">
        <MetricCard label="Partite uniche" value={performance?.games ?? 0} />
        <MetricCard label="Osservazioni · vittorie/sconfitte" value={`${performance?.observations ?? 0} · ${performance?.wins ?? 0}–${performance?.losses ?? 0}`} tone="info" />
        <MetricCard label={observed ? 'Media degli account esposti' : 'Affinità di catalogo'} value={observed ? pct(performance?.win_rate, 1) : candidate.similarity == null ? 'Non stimata' : pct(candidate.similarity * 100, 0)} tone="warning" />
      </section>
      <ObservedRecommendationCard item={candidate} feedbackAccounts={feedbackAccounts} allowAllAccountsShortcut={allowAllAccountsShortcut} feedbackRevision={feedbackRevision} />
      {observed && performance ? <Surface>
        <div className="section-heading"><div><p className="eyebrow">Risultati reali</p><h2>Copertura del confronto</h2></div><StatusBadge tone="neutral">Intervallo binomiale</StatusBadge></div>
        <p className="section-copy">La media complessiva nella carta usa gli account esposti. Il confronto qui sotto usa soltanto gli stessi {comparableAccountCount} account con dati per entrambe le scelte. Nessun prior e nessun minimo di 20 partite decide se mostrare il campione.</p>
        {performance.baseline_games > 0 ? <div className="compact-stat-list">
          <article><div><strong>Campione · account confrontabili</strong><span>Intervallo {pct(performance.paired_candidate_low, 1)}–{pct(performance.paired_candidate_high, 1)}</span></div><b>{pct(performance.paired_candidate_win_rate, 1)}</b></article>
          <article><div><strong>Riferimento · stessi account</strong><span>{performance.baseline_games} partite uniche · intervallo {pct(performance.baseline_low, 1)}–{pct(performance.baseline_high, 1)}</span></div><b>{pct(performance.baseline_win_rate, 1)}</b></article>
          <article><div><strong>Differenza negli account confrontabili ({comparableAccountCount})</strong><span>{comparableAccountCount}/{candidate.account_count} account esposti hanno dati per entrambe le scelte</span></div><b>{performance.lift_pp == null ? 'Non disponibile' : `${performance.lift_pp > 0 ? '+' : ''}${performance.lift_pp.toLocaleString('it-IT', { maximumFractionDigits: 1 })} pp`}</b></article>
        </div> : <p className="context-note">Non ci sono ancora altre scelte confrontabili nel ruolo e nella coda: il risultato grezzo resta visibile senza inventare un riferimento.</p>}
      </Surface> : null}
      {accountRows.length ? <DataTable label={`Risultati per account · ${roleLabel(candidate.role)}`}><thead><tr><th>Account</th><th>Partite</th><th>Vittorie</th><th>Sconfitte</th><th>Percentuale osservata</th></tr></thead><tbody>{accountRows.map((row, index) => <tr key={String(row.account ?? index)}><th scope="row">{String(row.account ?? 'Account')}</th><td>{String(row.games ?? '—')}</td><td>{String(row.wins ?? '—')}</td><td>{String(row.losses ?? '—')}</td><td>{typeof row.win_rate === 'number' ? pct(row.win_rate, 1) : '—'}</td></tr>)}</tbody></DataTable> : null}
      <p className="context-note">{contextNote}</p>
    </QueryResults>
  </section>
}

export function ChampionDetailPage({ champion: championProp, embedded = false }: ChampionDetailPageProps = {}) {
  const route = useParams<{ champion: string }>()
  const champion = championProp ?? route.champion ?? ''
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const roleParam = embedded ? 'detailRole' : 'role'
  const explicitRole = recommendationRoleFilter(params.get(roleParam))
  const { scope, scopeReady } = useScope()
  const queue = recommendationQueueFilter((embedded ? params.get('detailQueue') : null) ?? params.get('queue')) ?? undefined
  const days = recommendationPeriodFilter((embedded ? params.get('detailDays') : null) ?? params.get('days')) ?? undefined
  const result = useQuery({ ...recommendationsQuery(scope, { champion, role: explicitRole, queue, days }), enabled: scopeReady && Boolean(champion) })
  const data = result.data
  const candidate = data && explicitRole ? candidateFromResponse(champion, explicitRole, data.candidate, data.known, data.discover) : null
  const candidates = data && !explicitRole
    ? (data.candidates ?? [...data.known, ...data.discover]).filter((item) => item.champion.toLocaleLowerCase('it') === champion.toLocaleLowerCase('it'))
    : candidate ? [candidate] : []
  const primaryCandidate = candidates[0] ?? null
  const updateRole = (value: string) => setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(roleParam, value); else next.delete(roleParam); return next }, { replace: true, state: location.state })
  const selectedRoleLabel = explicitRole === 'AUTO' ? 'Ruolo automatico' : roleLabel(explicitRole ?? 'ALL')
  const header = (copy: string) => <PageHeader level={embedded ? 2 : 1} eyebrow="Campioni / Scheda" title={champion ? <>{primaryCandidate?.name || champion} · <em>{selectedRoleLabel}</em></> : 'Scheda campione'} copy={copy} aside={<label className="compact-select">Ruolo della scheda<select value={explicitRole ?? ''} onChange={(event) => updateRole(event.target.value)}>{explicitRole === 'AUTO' ? <option value="AUTO" disabled>Ruolo automatico</option> : null}<option value="">Tutti i ruoli · nessun filtro</option>{roles.map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>} />

  if (!champion) return <EmptyState title="Campione non disponibile" description="Seleziona un campione dalla lista per aprire la scheda." />
  if (result.isPending) return <div className="page-stack">{header('Sto leggendo gusti e risultati nel contesto selezionato.')}<Skeleton lines={8} /></div>
  if (result.isError) return <div className="page-stack">{header('Non riesco ancora a leggere la proposta corrente.')}<ErrorState title="Scheda non disponibile" error={result.error} onRetry={() => void result.refetch()} /></div>
  if (!data || !primaryCandidate) return <div className="page-stack">{header('La risposta non contiene questo campione nel ruolo richiesto.')}<EmptyState title="Campione fuori dal contesto" description="Il filtro esplicito resta invariato. Torna alla lista e scegli una proposta disponibile, oppure cambia ruolo." /></div>

  const suspendedAccounts = Array.isArray(data.context.suspended_accounts) ? data.context.suspended_accounts.map(String) : []
  const unresolvedAccounts = Array.isArray(data.context.unresolved_accounts) ? data.context.unresolved_accounts.map(String) : []
  const feedbackAccounts = data.coverage.selected_accounts.filter((account) => !suspendedAccounts.includes(account) && !unresolvedAccounts.includes(account))
  const allowAllAccountsShortcut = scope.accounts.length === 0 && feedbackAccounts.length === data.coverage.selected_accounts.length
  const contextNote = `Contesto effettivo: ${roleLabel(data.context.role)} · ${queueLabel(data.context.queue)} · ${preferencePeriodLabel(data.context.period, data.context.days)}. Revisione feedback ${data.feedback_revision}.`

  return <div className="page-stack">
    {!embedded ? <Link className="back-link" to="/app/fit?section=choices"><ArrowLeft aria-hidden="true" /> Torna alle scelte</Link> : null}
    <div className="champion-hero champion-hero--artwork"><div className="champion-hero__content">{header('Preferenze dichiarate, risultati reali e motivi della proposta nello stesso contesto della lista.')}</div><ChampionArtwork iconUrl={primaryCandidate.icon_url} champion={primaryCandidate.name || primaryCandidate.champion} /></div>
    {candidates.map((item) => <CandidateDetails key={`${item.champion}-${item.role}`} candidate={item} feedbackAccounts={feedbackAccounts} allowAllAccountsShortcut={allowAllAccountsShortcut} feedbackRevision={data.feedback_revision} isFetching={result.isFetching} contextNote={contextNote} identifyRole={!explicitRole} />)}
  </div>
}
