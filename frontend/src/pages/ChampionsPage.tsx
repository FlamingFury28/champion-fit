import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Swords } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'
import { matchupsQuery } from '../api/queries'
import { championHref } from '../app/navigation'
import { normalizeRole, pct, ROLES } from '../app/filters'
import { queueLabel, roleLabel } from '../app/labels'
import { selectActionableBan, signedPoints } from '../app/presentation'
import { useScope } from '../app/scope'
import { MatchupList } from '../components/MatchupList'
import { DecisionSummary, EmptyState, ErrorState, MetricCard, PageHeader, QueryResults, RefreshNotice, Skeleton, StatusBadge, Surface } from '../components/ui'

export function ChampionsPage({ embedded = false }: { embedded?: boolean }) {
  const { scope, scopeReady, availableAccounts } = useScope()
  const [params, setParams] = useSearchParams()
  const explicitRole = params.has('role') ? normalizeRole(params.get('role')) : 'ALL'
  const queue = params.get('queue') ?? 'all'
  const days = params.get('days') ?? 'all'
  const contextFilters = { queue, days }
  const matchups = useQuery({ ...matchupsQuery(scope, 'ALL', explicitRole, contextFilters), enabled: scopeReady })
  const role = explicitRole
  const navigate = useNavigate()
  const actionableBan = selectActionableBan(matchups.data?.loses_to ?? [])
  const candidateToWatch = matchups.data?.loses_to.find((item) => item.losses_to > 0)
  const banLift = actionableBan?.posterior_lift_pp ?? actionableBan?.relative_delta_pp ?? 0
  const transitioning = matchups.isPlaceholderData
  const roleName = role === 'ALL' ? 'tutti i ruoli' : roleLabel(role)
  const updateRole = (value: string) => setParams((current) => { const next = new URLSearchParams(current); if (value === 'ALL') next.delete('role'); else next.set('role', value); return next }, { replace: true })
  const updateContext = (key: 'queue' | 'days', value: string) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (value) next.set(key, value)
    else next.delete(key)
    return next
  }, { replace: true })
  const context = matchups.data?.context
  const selectedAccountHistory = scope.accounts.length === 1
    ? availableAccounts.find((account) => account.account === scope.accounts[0])?.analyzed_games
    : undefined
  const periodLabel = String(context?.days ?? '') === 'all'
    ? 'tutto lo storico'
    : context?.days ? `ultimi ${context.days} giorni` : 'periodo predefinito'

  return (
    <div className="page-stack">
      <PageHeader level={embedded ? 2 : 1} eyebrow="Campioni / Avversari" title="Avversari e ban" copy="Scopri quali avversari ti mettono in difficoltà. Ruolo, modalità e periodo definiscono i confronti; per un campione specifico apri la sua scheda." />
      {matchups.isPending ? <Skeleton lines={7} /> : null}
      {matchups.isError ? <ErrorState error={matchups.error} onRetry={() => void matchups.refetch()} /> : null}
      {matchups.data ? (
        <>
          <DecisionSummary
            answer={transitioning ? `Sto ricalcolando il ban per ${roleName}` : actionableBan ? `Banna ${actionableBan.champion}` : 'Nessun consiglio solido su chi bannare'}
            detail={transitioning
              ? 'La risposta precedente non viene presentata come una decisione per il nuovo filtro.'
              : actionableBan
              ? `Contro ${actionableBan.champion} rendi ${signedPoints(banLift)} rispetto al tuo solito, su ${actionableBan.games} partite osservate.`
              : candidateToWatch ? `Osserva ${candidateToWatch.champion}: è il primo segnale negativo, ma non è ancora abbastanza solido per consigliarti di bannarlo.` : 'I confronti osservati non sono ancora abbastanza solidi per indicare un avversario preciso.'}
            status={transitioning ? 'Aggiornamento' : actionableBan ? 'Da bannare' : 'Continua a osservare'}
            tone={transitioning ? 'info' : actionableBan ? 'warning' : 'info'}
            action={transitioning ? undefined : <div className="decision-summary__actions">
              {actionableBan ? <a className="button" href="#ban-evidence">Vedi perché <ArrowRight aria-hidden="true" /></a> : null}
              <a className="button button--secondary" href="#champion-selector">Calcola per un mio campione</a>
            </div>}
          />
          {transitioning ? <RefreshNotice>I dati sotto appartengono al filtro precedente e restano visibili solo mentre aggiorno {roleName}.</RefreshNotice> : null}
          <QueryResults label="Risultati dei confronti con gli avversari" aria-busy={matchups.isFetching && !matchups.isPending}>
            <Surface className="champion-selector-panel" id="champion-selector">
              <div><Swords aria-hidden="true" /><div><p className="eyebrow">Cambia la domanda</p><h2>Filtra la risposta</h2></div></div>
              <label>Ruolo<select value={explicitRole} onChange={(event) => updateRole(event.target.value)}>{ROLES.map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>
              <label>Modalità<select value={queue} onChange={(event) => updateContext('queue', event.target.value)}><option value="all">Tutte le modalità</option>{['420', '440', '400', '430', '490'].map((value) => <option key={value} value={value}>{queueLabel(value)}</option>)}</select></label>
              <label>Periodo<select value={days} onChange={(event) => updateContext('days', event.target.value)}><option value="all">Tutto lo storico</option><option value="90">Ultimi 90 giorni</option><option value="180">Ultimi 180 giorni</option><option value="365">Ultimi 365 giorni</option></select></label>
              <label>Che campione vuoi giocare?<select value="" disabled={transitioning} onChange={(event) => event.target.value && navigate(championHref(event.target.value, role, params), { state: { championSheetFromList: true } })}><option value="">{transitioning ? 'Aggiornamento dei campioni…' : 'Scegli un campione specifico…'}</option>{!transitioning ? matchups.data.available_champions.map((item) => <option key={item.champion} value={item.champion}>{item.champion} · {item.games} partite</option>) : null}</select></label>
              <p className="context-note" role="status">Contesto effettivo: {roleLabel(context?.role ?? role)} · {queueLabel(context?.queue)} · {periodLabel}. {selectedAccountHistory != null ? `L’account selezionato ha ${selectedAccountHistory} partite analizzate nello storico locale.` : 'Il totale del profilo comprende anche altre modalità e periodi.'}</p>
            </Surface>
            {matchups.data.games ? (
              <div className="matchup-grid" id="ban-evidence">
                <Surface><div className="section-heading"><div><p className="eyebrow">La risposta / rischio</p><h2>Ti mette più in difficoltà</h2></div><StatusBadge tone={actionableBan ? 'negative' : 'warning'}>{actionableBan ? 'da bannare per primo' : 'da verificare'}</StatusBadge></div><MatchupList items={matchups.data.loses_to} direction="loses" /></Surface>
                <Surface><div className="section-heading"><div><p className="eyebrow">Controllo / vantaggio</p><h2>Lo gestisci meglio</h2></div><StatusBadge tone="positive">vantaggio storico</StatusBadge></div><MatchupList items={matchups.data.beats} direction="beats" /></Surface>
              </div>
            ) : transitioning ? <Skeleton lines={4} label="Ricalcolo dei confronti" /> : <EmptyState title="Nessun confronto nei dati selezionati" description="Prova un altro ruolo o modifica gli account attivi." action={explicitRole !== 'ALL' ? <button className="button button--secondary" type="button" onClick={() => updateRole('ALL')}>Usa tutti i ruoli <ArrowRight aria-hidden="true" /></button> : undefined} />}
            <section className="metric-grid" aria-label={transitioning ? 'Contesto del filtro precedente' : 'Contesto della risposta'}>
              <MetricCard label={transitioning ? 'Partite personali · filtro precedente' : 'Partite personali nel contesto'} value={matchups.data.games} detail={`${queueLabel(context?.queue)} · ${periodLabel} · ${roleLabel(context?.role ?? role)}`} />
              <MetricCard label="Vittorie · sconfitte" value={`${matchups.data.wins}–${matchups.data.games - matchups.data.wins}`} tone="info" />
              <MetricCard label="Percentuale di vittorie" value={pct(matchups.data.win_rate)} tone="warning" />
              <MetricCard label="Partite con avversari noti" value={matchups.data.games_with_opponents} tone="neutral" />
            </section>
          </QueryResults>
        </>
      ) : null}
    </div>
  )
}
