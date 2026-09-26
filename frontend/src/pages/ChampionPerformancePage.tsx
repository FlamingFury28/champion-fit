import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { championsQuery } from '../api/queries'
import { normalizeRole, pct, ROLES, useDebouncedValue } from '../app/filters'
import { queueLabel, roleLabel } from '../app/labels'
import { championHref } from '../app/navigation'
import { useScope } from '../app/scope'
import { ChampionAvatar, DataTable, DecisionSummary, EmptyState, ErrorState, FilterBar, PageHeader, QueryResults, Skeleton, StatusBadge, Surface } from '../components/ui'

const playableRoles = ROLES.filter((role) => role !== 'ALL')

function periodLabel(days: unknown) {
  if (String(days) === 'all') return 'tutto lo storico'
  return days ? `ultimi ${days} giorni` : 'periodo predefinito'
}

function signalLabel(classification: string | undefined, historicallySupported: boolean) {
  if (historicallySupported) return { text: 'Vantaggio storico supportato', tone: 'warning' as const }
  if (classification === 'promising') return { text: 'Positivo da verificare', tone: 'info' as const }
  return { text: 'Nessun segnale positivo', tone: 'neutral' as const }
}

function liftLabel(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  const rounded = Number(Math.abs(value).toFixed(1)) * Math.sign(value)
  const normalized = Object.is(rounded, -0) ? 0 : rounded
  return `${normalized > 0 ? '+' : ''}${pct(normalized)}`
}

export function ChampionPerformancePage({ embedded = false }: { embedded?: boolean }) {
  const { scope, scopeReady } = useScope()
  const [params, setParams] = useSearchParams()
  const explicitRole = params.get('role') ?? ''
  const role = params.has('role') ? normalizeRole(explicitRole) : undefined
  const queue = params.get('queue') ?? ''
  const days = params.get('days') ?? ''
  const search = params.get('search') ?? ''
  const debouncedSearch = useDebouncedValue(search)
  const status = params.get('performance') ?? 'ALL'
  const filters = { role, status, search: debouncedSearch, queue: queue || undefined, days: days || undefined }
  const result = useQuery({ ...championsQuery(scope, filters), enabled: scopeReady })
  const data = result.data
  const update = (key: string, value: string) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (value) next.set(key, value)
    else next.delete(key)
    return next
  }, { replace: true })
  const items = data?.items ?? []
  const first = items[0]
  const selectedAccounts = scope.accounts.length ? scope.accounts.join(', ') : 'tutti gli account attivi'
  const currentContext = data?.context ?? {}
  const modelMessage = data?.model?.message ?? 'Il modello gerarchico è esplorativo finché non supera la validazione temporale.'

  return <div className="page-stack">
    <PageHeader level={embedded ? 2 : 1} eyebrow="Campioni / Rendimento" title="Quali giochi meglio?" copy="Confronta i risultati osservati per account, ruolo, modalità e periodo. I pick con pochi dati restano visibili come segnali da verificare." aside={result.isFetching && data ? <StatusBadge tone="info">Aggiornamento</StatusBadge> : undefined} />

    <FilterBar>
      <div className="filter-bar__intro"><strong>Contesto del confronto</strong><span>Account attivi: {selectedAccounts}. Cambia account dal selettore globale.</span></div>
      <label>Ruolo<select value={explicitRole} onChange={(event) => update('role', event.target.value)}><option value="">Automatico</option><option value="ALL">Tutti i ruoli</option>{playableRoles.map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>
      <label>Modalità<select value={queue} onChange={(event) => update('queue', event.target.value)}><option value="">Predefinita</option><option value="all">Tutte le modalità</option>{['420', '440', '400', '430', '490', '480', '700'].map((value) => <option key={value} value={value}>{queueLabel(value)}</option>)}</select></label>
      <label>Periodo<select value={days} onChange={(event) => update('days', event.target.value)}><option value="">Predefinito</option><option value="90">90 giorni</option><option value="180">180 giorni</option><option value="365">365 giorni</option><option value="all">Tutto lo storico</option></select></label>
      <label>Segnale<select value={status} onChange={(event) => update('performance', event.target.value)}><option value="ALL">Tutti</option><option value="supported">Vantaggio storico supportato</option><option value="promising">Positivi da verificare</option></select></label>
      <label className="search-field">Cerca<span><Search aria-hidden="true" /><input value={search} onChange={(event) => update('search', event.target.value)} placeholder="es. Ahri" /></span></label>
      <span className="filter-count" role="status">{result.isFetching && !result.isPending ? 'Aggiornamento…' : `${items.length} coppie campione/ruolo`}</span>
    </FilterBar>

    {result.isPending ? <Skeleton lines={8} label="Caricamento del rendimento dei campioni" /> : null}
    {result.isError ? <ErrorState title="Rendimento non disponibile" error={result.error} onRetry={() => void result.refetch()} /> : null}
    {data ? <>
      <DecisionSummary
        answer={first ? `Prima stima storica: ${first.champion} · ${pct(first.posterior_win_rate)}` : 'Nessun campione nel contesto selezionato'}
        detail={modelMessage}
        status={data.model?.validated ? 'Validazione temporale superata' : 'Analisi esplorativa'}
        tone={data.model?.validated ? 'positive' : 'warning'}
      />
      <Surface><div className="section-heading"><div><p className="eyebrow">Contesto effettivo</p><h2>{roleLabel(String(currentContext.role ?? ''))} · {queueLabel(String(currentContext.queue ?? ''))}</h2></div><StatusBadge tone="neutral">{periodLabel(currentContext.days)}</StatusBadge></div><p className="section-copy">{Number(currentContext.unique_games ?? 0)} partite uniche nel perimetro. Il modello usa esiti binari e standardizza l’account; gli effetti di modalità, patch e lobby sono parzialmente condivisi. La stima descrive associazioni storiche, non un effetto causale.</p></Surface>
      <QueryResults label="Classifica del rendimento storico" aria-busy={result.isFetching}>
        {items.length ? <DataTable label="Campioni ordinati per rendimento stimato"><thead><tr><th>Campione</th><th>Ruolo</th><th>Partite uniche</th><th>Stima aggiustata</th><th>Intervallo 90%</th><th>Scarto dal riferimento</th><th>Account coperti</th><th>Segnale</th></tr></thead><tbody>{items.map((item) => {
          const signal = signalLabel(item.classification, Boolean(item.historical_supported))
          const detail = championHref(item.champion, item.role, params)
          return <tr key={`${item.champion}-${item.role}`}>
            <th scope="row"><Link className="champion-link champion-link--interactive" state={{ championSheetFromList: true }} to={detail}><ChampionAvatar name={item.champion} src={item.icon_url} size="sm" /><span>{item.champion}</span></Link></th>
            <td>{roleLabel(item.role)}</td>
            <td className="numeric">{item.unique_games}</td>
            <td className="numeric numeric--hero">{pct(item.posterior_win_rate)}</td>
            <td className="numeric">{pct(item.credible_lower_90)}–{pct(item.credible_upper_90)}</td>
            <td className="numeric">{liftLabel(item.posterior_lift_pp)}</td>
            <td>{item.account_coverage ?? item.accounts_played}/{item.account_count ?? item.accounts_played}</td>
            <td><StatusBadge tone={signal.tone}>{signal.text}</StatusBadge></td>
          </tr>
        })}</tbody></DataTable> : <EmptyState title="Nessun campione corrisponde ai filtri" description="Rimuovi la ricerca o cambia account, ruolo, modalità o periodo per ampliare il confronto." />}
      </QueryResults>
      <aside className="context-note"><strong>Come leggere il segnale</strong><p>“Vantaggio storico supportato” indica un confronto retrospettivo corretto per i confronti multipli. Finché il modello non supera i fold temporali, anche questo risultato resta esplorativo e non è una previsione di vittoria. “Positivo da verificare” indica una stima sopra il riferimento con incertezza ancora ampia.</p></aside>
    </> : null}
  </div>
}
