import { useId, useState } from 'react'
import { pct } from '../app/filters'
import { roleLabel } from '../app/labels'
import '../champion-experience.css'

/** Compatible with both ProfileRecentMatchDto and ChampionRecentMatchDto. */
export interface RecentPerformanceMatch {
  date: string
  win: 0 | 1 | boolean
  account: string
  role: string
  champion?: string
  match_id?: string
}

interface ObservedDay {
  date: string
  timestamp: number
  wins: number
  matches: RecentPerformanceMatch[]
}

function validTimestamp(value: string): number | undefined {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value)
  if (!date) return undefined
  const year = Number(date[1]), month = Number(date[2]), day = Number(date[3])
  const calendar = new Date(Date.UTC(year, month - 1, day))
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

export function aggregateRecentPerformance(matches: readonly RecentPerformanceMatch[]) {
  const days = new Map<string, ObservedDay>()
  const seen = new Set<string>()
  let invalid = 0, duplicates = 0, withoutIdentity = 0
  const ordered = matches.flatMap((match) => {
    const timestamp = validTimestamp(match.date)
    if (timestamp === undefined || ![0, 1, true, false].includes(match.win)) {
      invalid += 1
      return []
    }
    return [{ match, timestamp }]
  }).sort((a, b) => a.timestamp - b.timestamp)

  for (const { match, timestamp } of ordered) {
    // A shared match is a separate observation for each account. Dates alone
    // cannot identify duplicate matches: several games may share a timestamp.
    if (match.match_id) {
      const identity = JSON.stringify([match.account, match.match_id])
      if (seen.has(identity)) { duplicates += 1; continue }
      seen.add(identity)
    } else {
      withoutIdentity += 1
    }
    const date = new Date(timestamp).toISOString().slice(0, 10)
    const entry = days.get(date) ?? { date, timestamp: Date.parse(date), wins: 0, matches: [] }
    entry.wins += Number(match.win)
    entry.matches.push(match)
    days.set(date, entry)
  }
  return { days: [...days.values()], invalid, duplicates, withoutIdentity }
}

function dayLabel(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function outcomes(wins: number, total: number) {
  const losses = total - wins
  return `${wins} ${wins === 1 ? 'vittoria' : 'vittorie'} e ${losses} ${losses === 1 ? 'sconfitta' : 'sconfitte'}`
}

export function RecentPerformance({ matches, title = 'La tua traccia recente', context, className = '', compact = false }: {
  matches: readonly RecentPerformanceMatch[]
  title?: string
  context?: string
  className?: string
  compact?: boolean
}) {
  const titleId = useId()
  const selectId = useId()
  const { days, invalid, duplicates, withoutIdentity } = aggregateRecentPerformance(matches)
  const [selectedDate, setSelectedDate] = useState('')
  const selected = days.find((day) => day.date === selectedDate) ?? days.at(-1)
  const first = days[0], last = days.at(-1)
  const observations = days.reduce((total, day) => total + day.matches.length, 0)
  const wins = days.reduce((total, day) => total + day.wins, 0)
  const x = (day: ObservedDay) => first && last && first.timestamp !== last.timestamp
    ? 50 + (day.timestamp - first.timestamp) / (last.timestamp - first.timestamp) * 530 : 315
  const y = (day: ObservedDay) => 150 - day.wins / day.matches.length * 120
  const inspection = selected ? <>
    <div className="recent-performance__inspection">
      <label htmlFor={selectId}>Esamina un giorno<select id={selectId} value={selected.date} onChange={(event) => setSelectedDate(event.target.value)}>{days.map((day) => <option key={day.date} value={day.date}>{dayLabel(day.date)} · {day.wins}/{day.matches.length} vittorie</option>)}</select></label>
      <p aria-live="polite"><strong>{dayLabel(selected.date)} · {pct(selected.wins / selected.matches.length * 100, 0)}</strong><span>{outcomes(selected.wins, selected.matches.length)} · {selected.matches.length} {selected.matches.length === 1 ? 'osservazione del giorno' : 'osservazioni del giorno'}.</span></p>
    </div>
    <ul className="recent-performance__matches" aria-label={`Osservazioni del ${dayLabel(selected.date)}`}>
      {selected.matches.map((match, index) => <li key={`${match.account}-${match.match_id ?? match.date}-${index}`}><span data-win={Boolean(match.win)}>{match.win ? 'V' : 'S'}<span className="sr-only">{match.win ? 'ittoria' : 'confitta'}</span></span><span><strong>{match.champion ? `${match.champion} · ` : ''}{roleLabel(match.role, true)}</strong><small>{match.account}</small></span></li>)}
    </ul>
  </> : null

  return (
    <section className={`recent-performance ${className}`} data-compact={compact} aria-labelledby={titleId}>
      <header className="recent-performance__heading">
        <div><p className="eyebrow">Esiti osservati</p><h2 id={titleId}>{title}</h2>{context ? <p className="recent-performance__context">{context}</p> : null}</div>
        {observations ? <div className="recent-performance__total"><strong>{pct(wins / observations * 100, 0)}</strong><span>{wins} {wins === 1 ? 'vittoria' : 'vittorie'} su {observations} {observations === 1 ? 'osservazione' : 'osservazioni'}</span></div> : null}
      </header>
      <p className="recent-performance__note">Solo le partite recenti restituite: una finestra limitata dello storico. La percentuale descrive questi esiti, senza stimare le prossime partite.</p>
      {selected && first && last ? (
        <>
          <figure className="recent-performance__figure">
            <svg viewBox="0 0 630 185" aria-hidden="true" className="recent-performance__plot">
              {[0, 50, 100].map((value) => <g key={value}><line className="recent-performance__grid" x1="50" x2="580" y1={150 - value * 1.2} y2={150 - value * 1.2} /><text x="37" y={154 - value * 1.2} textAnchor="end">{value}%</text></g>)}
              <line className="recent-performance__selection" x1={x(selected)} x2={x(selected)} y1="20" y2="155" />
              {days.map((day) => <g key={day.date} data-selected={selected.date === day.date}><line className="recent-performance__stem" x1={x(day)} x2={x(day)} y1="150" y2={y(day)} /><circle className="recent-performance__point" cx={x(day)} cy={y(day)} r={selected.date === day.date ? 6 : 4} /></g>)}
              <text x="50" y="179">{dayLabel(first.date)}</text>
              {days.length > 1 ? <text x="580" y="179" textAnchor="end">{dayLabel(last.date)}</text> : null}
            </svg>
            <figcaption>Vittorie osservate per giorno · date in UTC. I giorni senza osservazioni restano vuoti.</figcaption>
          </figure>
          {days.length < 2 ? <p className="recent-performance__note">Un solo giorno disponibile: serve una finestra più ampia per confrontare giornate diverse.</p> : null}
          {compact ? <details className="recent-performance__disclosure"><summary>Esamina giornate e partite</summary>{inspection}</details> : inspection}
        </>
      ) : <p className="recent-performance__empty">Nessuna osservazione con data ed esito validi da rappresentare.</p>}
      {observations > 0 ? <p className="recent-performance__note recent-performance__footnote">Il conteggio è per account: una partita condivisa può comparire più volte.{withoutIdentity > 0 ? ' Gli identificativi disponibili non consentono di riconoscere tutte le partite distinte.' : ''}</p> : null}
      {invalid > 0 || duplicates > 0 ? <p className="recent-performance__note">{invalid > 0 ? `${invalid} ${invalid === 1 ? 'osservazione esclusa' : 'osservazioni escluse'} per data o esito non validi. ` : ''}{duplicates > 0 ? `${duplicates} ${duplicates === 1 ? 'duplicato dello stesso account e partita escluso' : 'duplicati dello stesso account e partita esclusi'}.` : ''}</p> : null}
    </section>
  )
}
