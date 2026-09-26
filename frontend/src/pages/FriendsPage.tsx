import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, UsersRound, X } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { deleteJson, patchJson, postJson } from '../api/client'
import { invalidateAfterFriendGroup } from '../api/invalidation'
import { friendsQuery } from '../api/queries'
import type { FriendDto, FriendGroupDto, FriendGroupMutationResponseDto } from '../api/types'
import { clampInteger, formatDate, pct } from '../app/filters'
import { credibleBounds, credibleMassLabel, getSetting, useAlgorithmSettings } from '../app/algorithm-settings'
import { apiErrorLabel, queueLabel, roleLabel } from '../app/labels'
import { reliabilityLabel, resolvedReliability } from '../app/reliability'
import { useScope } from '../app/scope'
import { DataExplorer, type DataVisualItem } from '../components/DataExplorer'
import { useToast } from '../components/toast'
import { DataTable, EmptyState, ErrorState, FilterBar, MetricCard, Modal, PageHeader, QueryResults, Skeleton, StatusBadge, Surface } from '../components/ui'

type SortField = 'games' | 'winrate' | 'last_game'
type SortDirection = 'asc' | 'desc'
type SortItem = [SortField, SortDirection]
type GroupAction =
  | { kind: 'create'; name: string; aliases: string[] }
  | { kind: 'add-aliases'; id: number; groupName: string; aliases: string[] }
  | { kind: 'rename'; id: number; name: string }
  | { kind: 'delete-group'; id: number }
  | { kind: 'delete-alias'; id: number; alias: string }

function parseSort(value: string | null): SortItem[] {
  const items = (value ?? 'games:desc').split(',').map((item) => item.split(':'))
    .filter((item): item is [SortField, SortDirection] => {
      const field = item[0]
      const direction = item[1]
      return typeof field === 'string' && typeof direction === 'string'
        && ['games', 'winrate', 'last_game'].includes(field)
        && ['asc', 'desc'].includes(direction)
    })
  return items.length ? items : [['games', 'desc']]
}

export function friendsMinimumGamesFromSettings(value: unknown) {
  return clampInteger(String(value ?? ''), 1, 10_000, 5)
}

export function friendsFiltersFromParams(params: URLSearchParams, configuredMinimumGames: number) {
  return {
    role: params.get('role') ?? 'ALL',
    queue: params.get('queue') ?? 'all',
    friend_q: params.get('name') ?? '',
    games_from: params.get('games_from') ?? '',
    last_game_from: params.get('last_game_from') ?? '',
    min_shared_games: clampInteger(params.get('min_games'), 1, 10_000, configuredMinimumGames),
    sort: parseSort(params.get('sort')).map(([field, direction]) => `${field}:${direction}`).join(','),
  }
}

function friendSignal(friend: FriendDto, minimumGames: number, meaningfulDelta: number) {
  if (friend.actionable) {
    const label = friend.recommendation === 'beats' ? 'Vantaggio supportato'
      : friend.recommendation === 'loses_to' ? 'Svantaggio supportato' : 'Differenza supportata'
    const tone = friend.recommendation === 'beats' ? 'positive' as const
      : friend.recommendation === 'loses_to' ? 'negative' as const : 'info' as const
    return { label, brief: 'Soglia superata', tone, detail: 'Il confronto supera la soglia statistica configurata.' }
  }
  const lift = friend.posterior_lift_pp ?? (friend.posterior_win_rate - friend.baseline_win_rate) * 100
  const formatPoints = (value: number) => `${new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(value)} pp`
  if (friend.mixed_role_context) {
    const tendency = lift >= meaningfulDelta * 100 ? 'sopra'
      : lift <= -meaningfulDelta * 100 ? 'sotto' : 'vicina'
    const signedLift = `${lift > 0 ? '+' : lift < 0 ? '−' : ''}${formatPoints(Math.abs(lift))}`
    return {
      label: 'Confronto multi-ruolo', brief: `Stima ${signedLift} · descrittiva`, tone: 'warning' as const,
      detail: `Stima ${tendency} al riferimento (${signedLift}); è descrittiva perché le partite condivise includono più ruoli. ${friend.decision_reason || 'Seleziona un ruolo per un confronto omogeneo.'}`,
    }
  }
  if (friend.missing_role_baselines?.length) {
    return {
      label: 'Riferimento incompleto', brief: 'Manca una baseline', tone: 'warning' as const,
      detail: friend.decision_reason || 'Manca il riferimento nello stesso ruolo per alcuni account.',
    }
  }
  if (friend.shared_games < minimumGames) {
    return {
      label: 'Campione ridotto', brief: `${friend.shared_games}/${minimumGames} partite`, tone: 'warning' as const,
      detail: `${friend.shared_games} partite osservate; ne servono almeno ${minimumGames} per una decisione.`,
    }
  }

  if (lift >= meaningfulDelta * 100) {
    const probability = friend.probability_meaningful_advantage
    const probabilityNote = probability == null ? '' : ` Probabilità del vantaggio: ${pct(probability, 1)}.`
    const thresholdNote = friend.decision_threshold == null ? '' : ` Soglia prudente: ${pct(friend.decision_threshold, 3)}.`
    return {
      label: 'Tendenza favorevole', brief: `+${formatPoints(lift)} · non confermata`, tone: 'info' as const,
      detail: `Stima sopra il riferimento di ${formatPoints(lift)}, ma non confermata.${probabilityNote}${thresholdNote}`,
    }
  }
  if (lift <= -meaningfulDelta * 100) {
    const probability = friend.probability_meaningful_disadvantage
    const probabilityNote = probability == null ? '' : ` Probabilità dello svantaggio: ${pct(probability, 1)}.`
    const thresholdNote = friend.decision_threshold == null ? '' : ` Soglia prudente: ${pct(friend.decision_threshold, 3)}.`
    return {
      label: 'Tendenza sfavorevole', brief: `−${formatPoints(Math.abs(lift))} · non confermata`, tone: 'info' as const,
      detail: `Stima sotto il riferimento di ${formatPoints(Math.abs(lift))}, ma non confermata.${probabilityNote}${thresholdNote}`,
    }
  }
  return {
    label: 'In linea col riferimento', brief: `${formatPoints(lift)} · sotto soglia`, tone: 'neutral' as const,
    detail: `Differenza stimata: ${formatPoints(lift)}; inferiore alla soglia pratica di ${formatPoints(meaningfulDelta * 100)}.`,
  }
}

export function FriendsPage() {
  const { credibleMass, settings, isPending: settingsPending } = useAlgorithmSettings()
  const { scope, scopeReady } = useScope()
  const [params, setParams] = useSearchParams()
  const configuredMinimumGames = friendsMinimumGamesFromSettings(getSetting(settings, 'friends.min_shared_games'))
  const configuredDecisionGames = Number(getSetting(settings, 'evidence.min_games'))
  const decisionMinimumGames = Number.isFinite(configuredDecisionGames) && configuredDecisionGames > 0 ? configuredDecisionGames : 20
  const configuredDelta = Number(getSetting(settings, 'evidence.meaningful_delta'))
  const meaningfulDelta = Number.isFinite(configuredDelta) && configuredDelta >= 0 ? configuredDelta : 0.03
  const filters = useMemo(() => friendsFiltersFromParams(params, configuredMinimumGames), [configuredMinimumGames, params])
  const [minimumGames, setMinimumGames] = useState({
    value: filters.min_shared_games,
    draft: String(filters.min_shared_games),
    error: '',
  })
  if (minimumGames.value !== filters.min_shared_games) {
    setMinimumGames({ value: filters.min_shared_games, draft: String(filters.min_shared_games), error: '' })
  }
  const { draft: minGamesDraft, error: minGamesError } = minimumGames
  const friends = useQuery({ ...friendsQuery(scope, filters), enabled: scopeReady && (!settingsPending || params.has('min_games')) })
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [aliases, setAliases] = useState('')
  const [addAliasesGroup, setAddAliasesGroup] = useState<FriendGroupDto | null>(null)
  const [addAliasesValue, setAddAliasesValue] = useState('')
  const [renameGroup, setRenameGroup] = useState<FriendGroupDto | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmAction, setConfirmAction] = useState<GroupAction | null>(null)

  const groupMutation = useMutation({
    mutationFn: async (action: GroupAction) => {
      if (action.kind === 'create') return postJson<FriendGroupMutationResponseDto>('/api/friend-groups', { name: action.name, aliases: action.aliases })
      if (action.kind === 'add-aliases') return postJson<FriendGroupMutationResponseDto>(`/api/friend-groups/${action.id}/aliases`, { aliases: action.aliases })
      if (action.kind === 'rename') return patchJson<FriendGroupMutationResponseDto>(`/api/friend-groups/${action.id}`, { name: action.name })
      if (action.kind === 'delete-alias') return deleteJson<FriendGroupMutationResponseDto>(`/api/friend-groups/${action.id}/aliases/${encodeURIComponent(action.alias)}`)
      return deleteJson<FriendGroupMutationResponseDto>(`/api/friend-groups/${action.id}`)
    },
    onSuccess: async (result, action) => {
      await invalidateAfterFriendGroup(queryClient)
      const title = action.kind === 'create' ? 'Gruppo creato'
        : action.kind === 'add-aliases' ? result.added_aliases?.length ? 'Persone aggiunte' : 'Nessun Riot ID nuovo'
          : action.kind === 'rename' ? 'Gruppo rinominato'
            : action.kind === 'delete-alias' ? 'Alias rimosso' : 'Gruppo rimosso'
      const description = action.kind === 'add-aliases'
        ? result.added_aliases?.length
          ? `${result.added_aliases.length} Riot ID aggiunti a ${action.groupName}.`
          : 'I Riot ID inseriti erano già presenti nel gruppo.'
        : undefined
      notify(title, { description, tone: 'success' })
      setCreateOpen(false); setAddAliasesGroup(null); setAddAliasesValue(''); setRenameGroup(null); setConfirmAction(null); setGroupName(''); setAliases('')
    },
    onError: (error) => notify('Modifica non riuscita', { description: apiErrorLabel(error.message), tone: 'error' }),
  })

  const update = (key: string, value: string, fallback = '') => setParams((current) => {
    const next = new URLSearchParams(current)
    if (!value || value === fallback) next.delete(key); else next.set(key, value)
    return next
  }, { replace: true })

  const commitMinimumGames = () => {
    if (!/^\d+$/.test(minGamesDraft.trim())) {
      setMinimumGames({ ...minimumGames, error: 'Inserisci un numero intero tra 1 e 10000.' })
      return
    }
    const next = clampInteger(minGamesDraft, 1, 10_000, configuredMinimumGames)
    setMinimumGames({ value: filters.min_shared_games, draft: String(next), error: '' })
    update('min_games', String(next), String(configuredMinimumGames))
  }

  const applySort = (field: SortField, direction: SortDirection) => {
    const current = parseSort(params.get('sort'))
    update('sort', [[field, direction], ...current.filter(([name]) => name !== field)].map(([name, order]) => `${name}:${order}`).join(','), 'games:desc')
  }

  const toggleSort = (field: SortField) => {
    const current = parseSort(params.get('sort'))
    const existing = current.find(([name]) => name === field)
    const direction: SortDirection = existing?.[1] === 'desc' ? 'asc' : 'desc'
    applySort(field, direction)
  }

  const submitCreate = (event: FormEvent) => {
    event.preventDefault()
    const values = aliases.split(',').map((value) => value.trim()).filter(Boolean)
    if (!groupName.trim() || !values.length) return
    groupMutation.mutate({ kind: 'create', name: groupName.trim(), aliases: values })
  }

  const submitAddAliases = (event: FormEvent) => {
    event.preventDefault()
    if (!addAliasesGroup) return
    const seen = new Set<string>()
    const values = addAliasesValue.split(/[\n,;]/).map((value) => value.trim()).filter((value) => {
      const key = value.toLocaleLowerCase()
      if (!value || seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (!values.length) return
    groupMutation.mutate({ kind: 'add-aliases', id: addAliasesGroup.id, groupName: addAliasesGroup.name, aliases: values })
  }

  const sort = parseSort(params.get('sort'))
  const sortAria = (field: SortField) => {
    const value = sort.find(([name]) => name === field)?.[1]
    return value === 'asc' ? 'ascending' : value === 'desc' ? 'descending' : 'none'
  }
  const visualFriends: DataVisualItem[] = (friends.data?.items ?? []).map((friend) => {
    const signal = friendSignal(friend, decisionMinimumGames, meaningfulDelta)
    return {
      id: friend.friend_key,
      label: friend.friend,
      subtitle: `${signal.label} · ${friend.accounts_played_with} account selezionati · ultima partita ${formatDate(friend.last_game)}`,
      value: friend.posterior_win_rate,
      valueLabel: pct(friend.posterior_win_rate, 1),
      low: credibleBounds(friend).lower,
      high: credibleBounds(friend).upper,
      reference: friend.baseline_win_rate,
      sample: friend.shared_games,
      sampleLabel: 'Partite condivise',
      tone: signal.tone,
      details: <>
        <StatusBadge tone={signal.tone}>{signal.label}</StatusBadge>
        <p>{signal.detail}</p>
        <p>{reliabilityLabel(resolvedReliability(friend.reliability, friend.personal_effective_sample_size ?? friend.shared_games, friend.actionable))} · campione effettivo delle evidenze pesate: {Number(friend.personal_effective_sample_size ?? 0).toFixed(1)}</p>
        <p>Percentuale di vittorie osservata {pct(friend.friend_win_rate)} · riferimento {pct(friend.baseline_win_rate, 1)}</p>
        <p>Intervallo {credibleMassLabel(friend.credible_mass ?? credibleMass)} della stima vittorie {pct(credibleBounds(friend).lower, 1)}–{pct(credibleBounds(friend).upper, 1)}</p>
      </>,
    }
  })
  const groupAliases = (group: FriendGroupDto) => <div className="empty-actions">{group.aliases.map((alias) => <span className="alias-chip" key={alias}>{alias}<button type="button" aria-label={`Rimuovi alias ${alias}`} onClick={() => setConfirmAction({ kind: 'delete-alias', id: group.id, alias })}><X aria-hidden="true" /></button></span>)}</div>
  const groupActions = (group: FriendGroupDto) => <span className="empty-actions"><button className="icon-button" type="button" aria-label={`Aggiungi persone a ${group.name}`} title="Aggiungi persone" onClick={() => { setAddAliasesGroup(group); setAddAliasesValue('') }}><Plus aria-hidden="true" /></button><button className="icon-button" type="button" aria-label={`Rinomina ${group.name}`} onClick={() => { setRenameGroup(group); setRenameValue(group.name) }}><Pencil aria-hidden="true" /></button><button className="icon-button" type="button" aria-label={`Elimina ${group.name}`} onClick={() => setConfirmAction({ kind: 'delete-group', id: group.id })}><Trash2 aria-hidden="true" /></button></span>
  const visualGroups: DataVisualItem[] = (friends.data?.manual_groups ?? []).map((group) => ({
    id: String(group.id),
    label: group.name,
    value: group.aliases.length,
    valueLabel: `${group.aliases.length} alias`,
    tone: 'neutral',
    details: groupAliases(group),
    action: groupActions(group),
  }))

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Squadra" title={<>Compagni</>} copy="Le persone incontrate nella tua squadra sono riconosciute dai Riot ID. Confronta le partite condivise e riunisci i diversi Riot ID della stessa persona." aside={<button className="button" type="button" onClick={() => setCreateOpen(true)}><Plus aria-hidden="true" /> Nuovo gruppo</button>} />
      <p className="context-note" role="status">Contesto: {filters.queue === 'all' ? 'tutte le modalità' : queueLabel(filters.queue)} · tutto lo storico · ruolo {roleLabel(filters.role)}. Per un confronto omogeneo seleziona una modalità e un ruolo specifici.</p>
      <FilterBar>
        <label>Modalità del confronto
          <select value={filters.queue} onChange={(event) => update('queue', event.target.value, 'all')}>
            <option value="all">Tutte le modalità · aggregato</option>
            <option value="420">Classificata Solo/Duo</option>
            <option value="440">Classificata Flex</option>
            <option value="400">Normale Draft</option>
            <option value="430">Normale Blind</option>
            <option value="450">ARAM</option>
            <option value="480">Swiftplay</option>
            <option value="490">Quickplay</option>
            <option value="700">Clash</option>
          </select>
        </label>
        <label>Ruolo del confronto
          <select value={filters.role} onChange={(event) => update('role', event.target.value, 'ALL')}>
            <option value="ALL">Tutti i ruoli · aggregato</option>
            <option value="TOP">Corsia superiore</option>
            <option value="JUNGLE">Giungla</option>
            <option value="MIDDLE">Corsia centrale</option>
            <option value="BOTTOM">Corsia inferiore</option>
            <option value="SUPPORT">Supporto</option>
          </select>
        </label>
        <label>Nome o Riot ID<input value={filters.friend_q} onChange={(event) => update('name', event.target.value)} placeholder="Cerca un compagno" /></label>
        <label>Conta le partite dal<input type="date" value={filters.games_from} onChange={(event) => update('games_from', event.target.value)} /></label>
        <label>Ultima partita dal<input type="date" value={filters.last_game_from} onChange={(event) => update('last_game_from', event.target.value)} /></label>
        <label>Almeno quante partite?
          <input type="text" inputMode="numeric" pattern="[0-9]*" value={minGamesDraft} aria-invalid={Boolean(minGamesError)} aria-describedby={minGamesError ? 'friends-min-games-error' : undefined} onChange={(event) => setMinimumGames({ ...minimumGames, draft: event.target.value })} onBlur={commitMinimumGames} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
          {minGamesError ? <span className="field-error" id="friends-min-games-error">{minGamesError}</span> : null}
        </label>
        <label>Ordine principale
          <select value={(sort[0] ?? ['games', 'desc']).join(':')} onChange={(event) => { const [field, direction] = event.target.value.split(':') as SortItem; applySort(field, direction) }}>
            <option value="games:desc">Più partite condivise</option>
            <option value="games:asc">Meno partite condivise</option>
            <option value="winrate:desc">Vittorie osservate: più alte</option>
            <option value="winrate:asc">Vittorie osservate: più basse</option>
            <option value="last_game:desc">Ultima partita più recente</option>
            <option value="last_game:asc">Ultima partita meno recente</option>
          </select>
        </label>
        <span className="filter-count" role="status">{friends.isFetching && !friends.isPending ? 'Aggiornamento risultati…' : `${friends.data?.items.length ?? 0} compagni`}</span>
      </FilterBar>
      {friends.isPending ? <Skeleton lines={8} label="Caricamento compagni" /> : null}
      {friends.isError ? <ErrorState error={friends.error} onRetry={() => void friends.refetch()} /> : null}
      {friends.data ? (
        <QueryResults label="Risultati dei compagni di squadra" aria-busy={friends.isFetching && !friends.isPending}>
          <section className="metric-grid metric-grid--three">
            <MetricCard label="Account considerati" value={friends.data.summary.tracked_accounts} />
            <MetricCard label="Partite con partecipanti" value={friends.data.summary.matches_with_participants} tone="info" />
            <MetricCard label={`Compagni · ≥ ${friends.data.summary.min_shared_games} partite`} value={friends.data.summary.friends_found} tone="warning" />
          </section>
          <div className="friends-layout">
            <Surface className="friends-ranking">
              <div className="section-heading"><div><p className="eyebrow"><UsersRound aria-hidden="true" /> Classifica</p><h2>Partite condivise</h2></div><span>{sort.map(([field, direction]) => `${{ games: 'Partite', winrate: '% vittorie', last_game: 'Ultima partita' }[field]} ${direction === 'asc' ? 'crescente' : 'decrescente'}`).join(' → ')}</span></div>
              <p className="section-copy">La stima confronta gli esiti con il riferimento dell’account. Le etichette distinguono contesti multi-ruolo, campioni ridotti, tendenze non confermate e differenze supportate.</p>
              {friends.data.items.length ? <DataExplorer
                id="friends-ranking"
                label="Compagni di squadra"
                items={visualFriends}
                metricLabel="Percentuale di vittorie stimata"
                valueDomain={[0, 100]}
                valueSuffix="%"
                sampleLabel="Partite condivise"
                listLabel="Tabella"
              ><DataTable label="Classifica dei compagni di squadra">
                <thead><tr><th>#</th><th>Compagno</th><th aria-sort={sortAria('games')}><button className="sort-button" type="button" onClick={() => toggleSort('games')}>Partite {sortAria('games') === 'ascending' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}</button></th><th aria-sort={sortAria('winrate')}><button className="sort-button" type="button" onClick={() => toggleSort('winrate')}>Percentuale di vittorie osservata {sortAria('winrate') === 'ascending' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}</button></th><th>Stima e intervallo {credibleMassLabel(credibleMass)}</th><th>Segnale</th><th aria-sort={sortAria('last_game')}><button className="sort-button" type="button" onClick={() => toggleSort('last_game')}>Ultima partita {sortAria('last_game') === 'ascending' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}</button></th></tr></thead>
                <tbody>{friends.data.items.map((friend, index) => { const signal = friendSignal(friend, decisionMinimumGames, meaningfulDelta); return <tr key={friend.friend_key}><td className="row-rank">{String(index + 1).padStart(2, '0')}</td><th scope="row">{friend.friend}<small>{friend.accounts_played_with} account selezionati</small></th><td className="numeric">{friend.shared_games}</td><td>{pct(friend.friend_win_rate)}</td><td><strong>{pct(friend.posterior_win_rate, 1)}</strong><small>{pct(credibleBounds(friend).lower, 1)}–{pct(credibleBounds(friend).upper, 1)}</small><small>Riferimento {pct(friend.baseline_win_rate, 1)} · campione effettivo pesato {Number(friend.personal_effective_sample_size ?? 0).toFixed(1)}</small></td><td><StatusBadge tone={signal.tone}>{signal.label}</StatusBadge><small>{signal.brief}</small><small>{reliabilityLabel(resolvedReliability(friend.reliability, friend.personal_effective_sample_size ?? friend.shared_games, friend.actionable))}</small></td><td>{formatDate(friend.last_game)}</td></tr> })}</tbody>
              </DataTable></DataExplorer> : <EmptyState title="Nessun risultato per questi filtri" description="Riduci la soglia o amplia l'intervallo temporale. Gli account considerati non vengono modificati automaticamente." />}
            </Surface>
            <Surface className="group-panel">
              <div className="section-heading"><div><p className="eyebrow">Identità manuali</p><h2>Gruppi di nomi</h2></div><span>{friends.data.manual_groups.length} gruppi</span></div>
              {friends.data.manual_groups.length ? <DataExplorer
                id="friend-groups"
                label="Gruppi di nomi"
                items={visualGroups}
                metricLabel="Alias associati"
                views={['list', 'cards']}
              ><div className="friend-group-list">{friends.data.manual_groups.map((group) => <article key={group.id}>
                <header><strong>{group.name}</strong>{groupActions(group)}</header>
                {groupAliases(group)}
              </article>)}</div></DataExplorer> : <EmptyState title="Nessun gruppo manuale" description="Crea un gruppo per unire più Riot ID della stessa persona." />}
            </Surface>
          </div>
        </QueryResults>
      ) : null}

      <Modal open={createOpen} onOpenChange={setCreateOpen} title="Crea gruppo di nomi" description="Unisci i diversi nomi che rappresentano la stessa persona. Le partite non vengono modificate.">
        <form className="stack-form" onSubmit={submitCreate}><label>Nome gruppo<input value={groupName} onChange={(event) => setGroupName(event.target.value)} required maxLength={80} /></label><label>Alias, separati da virgola<textarea value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="Nome#EUW, AltroNome#EUW" required /></label>{groupMutation.isError ? <p className="form-error" role="alert">{apiErrorLabel(groupMutation.error.message)}</p> : null}<div className="dialog-actions"><button className="button button--ghost" type="button" onClick={() => setCreateOpen(false)}>Annulla</button><button className="button" type="submit" disabled={groupMutation.isPending}>{groupMutation.isPending ? 'Creazione…' : 'Crea gruppo'}</button></div></form>
      </Modal>
      <Modal open={Boolean(addAliasesGroup)} onOpenChange={(open) => !open && setAddAliasesGroup(null)} title={`Aggiungi persone a ${addAliasesGroup?.name ?? 'gruppo'}`} description="Inserisci uno o più Riot ID, separati da virgole o su righe diverse.">
        <form className="stack-form" onSubmit={submitAddAliases}><label>Riot ID<textarea value={addAliasesValue} onChange={(event) => setAddAliasesValue(event.target.value)} placeholder="Nome#EUW, AltroNome#EUW" required /></label>{groupMutation.isError ? <p className="form-error" role="alert">{apiErrorLabel(groupMutation.error.message)}</p> : null}<div className="dialog-actions"><button className="button button--ghost" type="button" onClick={() => setAddAliasesGroup(null)}>Annulla</button><button className="button" type="submit" disabled={groupMutation.isPending}>{groupMutation.isPending ? 'Aggiunta…' : 'Aggiungi al gruppo'}</button></div></form>
      </Modal>
      <Modal open={Boolean(renameGroup)} onOpenChange={(open) => !open && setRenameGroup(null)} title="Rinomina gruppo di nomi">
        <form className="stack-form" onSubmit={(event) => { event.preventDefault(); if (renameGroup && renameValue.trim()) groupMutation.mutate({ kind: 'rename', id: renameGroup.id, name: renameValue.trim() }) }}><label>Nuovo nome<input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} required maxLength={80} /></label><div className="dialog-actions"><button className="button button--ghost" type="button" onClick={() => setRenameGroup(null)}>Annulla</button><button className="button" type="submit" disabled={groupMutation.isPending}>Salva nome</button></div></form>
      </Modal>
      <Modal open={Boolean(confirmAction)} onOpenChange={(open) => !open && setConfirmAction(null)} title={confirmAction?.kind === 'delete-alias' ? 'Rimuovere questo alias?' : 'Rimuovere questo gruppo?'} description="L'operazione non cancella alcuna partita, ma modifica il modo in cui le identità vengono aggregate.">
        <div className="dialog-actions"><button className="button button--ghost" type="button" onClick={() => setConfirmAction(null)}>Annulla</button><button className="button button--danger" type="button" disabled={groupMutation.isPending} onClick={() => confirmAction && groupMutation.mutate(confirmAction)}>Conferma rimozione</button></div>
      </Modal>
    </div>
  )
}
