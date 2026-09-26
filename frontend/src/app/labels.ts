/** Italian display labels. Wire values, player names and routes stay unchanged. */
const roles: Record<string, [string, string]> = {
  ALL: ['Tutti i ruoli', 'Tutti'],
  TOP: ['Corsia superiore', 'Superiore'],
  JUNGLE: ['Giungla', 'Giungla'],
  MIDDLE: ['Corsia centrale', 'Centrale'],
  MID: ['Corsia centrale', 'Centrale'],
  BOTTOM: ['Corsia inferiore', 'Inferiore'],
  BOT: ['Corsia inferiore', 'Inferiore'],
  SUPPORT: ['Supporto', 'Supporto'],
  UTILITY: ['Supporto', 'Supporto'],
}

export function roleLabel(value: string | null | undefined, compact = false) {
  return roles[value?.trim().toUpperCase() ?? '']?.[compact ? 1 : 0] ?? 'Ruolo non definito'
}

const queues: Record<string, string> = {
  ALL: 'Tutte le modalità',
  '400': 'Normale · scelta alternata',
  DRAFTPICK: 'Normale · scelta alternata',
  NORMALDRAFT: 'Normale · scelta alternata',
  NORMALDRAFT5X5: 'Normale · scelta alternata',
  '420': 'Classificata · Solo/Duo',
  RANKEDSOLO: 'Classificata · Solo/Duo',
  RANKEDSOLODUO: 'Classificata · Solo/Duo',
  RANKEDSOLO5X5: 'Classificata · Solo/Duo',
  '430': 'Normale · scelta segreta',
  BLINDPICK: 'Normale · scelta segreta',
  NORMALBLIND: 'Normale · scelta segreta',
  NORMAL5X5BLIND: 'Normale · scelta segreta',
  '440': 'Classificata · flessibile',
  RANKEDFLEX: 'Classificata · flessibile',
  RANKEDFLEXSR: 'Classificata · flessibile',
  '480': 'Partita rapida',
  SWIFTPLAY: 'Partita rapida',
  '490': 'Partita veloce',
  QUICKPLAY: 'Partita veloce',
  NORMALQUICKPLAY: 'Partita veloce',
  '700': 'Clash',
  CLASH: 'Clash',
  '450': 'ARAM',
  ARAM: 'ARAM',
}

export function queueLabel(value: string | number | null | undefined) {
  const key = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^QUEUE/, '')
  return queues[key] ?? 'Modalità non specificata'
}

export function preferencePeriodLabel(period: unknown, fallbackDays?: unknown) {
  if (period && typeof period === 'object' && !Array.isArray(period)) {
    const value = Number((period as Record<string, unknown>).value)
    const unit = (period as Record<string, unknown>).unit
    if (Number.isInteger(value) && value === 0) return 'tutto lo storico'
    if (Number.isInteger(value) && value > 0) {
      return unit === 'games' ? `ultime ${value} partite per account` : `ultimi ${value} giorni`
    }
  }
  if (String(fallbackDays ?? '') === 'all') return 'tutto lo storico'
  return fallbackDays == null ? 'periodo predefinito' : `ultimi ${fallbackDays} giorni`
}

const tags: Record<string, string> = {
  tank: 'Difensore', fighter: 'Combattente', assassin: 'Assassino', mage: 'Mago',
  marksman: 'Tiratore', support: 'Supporto', burst: 'Danni concentrati',
  control: 'Controllo', crowd_control: 'Controllo', mobility: 'Mobilità',
  sustain: 'Recupero', sustained: 'Danno prolungato', poke: 'Pressione a distanza', engage: 'Inizio dello scontro',
  disengage: 'Disimpegno', utility: 'Utilità', damage: 'Danni',
  scaling: 'Crescita nel tempo', ranged: 'A distanza', melee: 'Corpo a corpo',
  peel: 'Protezione degli alleati', zone: 'Controllo dell’area', duel: 'Duello', sidelane: 'Pressione laterale',
  external_tags_unavailable: 'Caratteristiche non disponibili',
}

export function tagLabel(value: string) {
  return tags[value.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? value.replace(/_/g, ' ')
}

const anomalyFlags: Record<string, string> = {
  none: 'Nessuna anomalia', afk: 'Giocatore inattivo (AFK)',
  explicit_afk: 'Inattività rilevata (AFK)', suspected_quasi_afk: 'Possibile inattività',
  quasi_afk: 'Possibile inattività', near_afk: 'Possibile inattività',
  early_surrender: 'Resa anticipata', early_team_collapse: 'Crollo precoce della squadra',
  team_collapse: 'Crollo della squadra', short_game: 'Partita breve',
  short_duration: 'Durata ridotta', remake: 'Partita annullata',
  kill_deficit: 'Forte svantaggio nelle uccisioni', severe_kill_deficit: 'Forte svantaggio nelle uccisioni',
  explicit_afk_teammate: 'Compagno inattivo (AFK)',
  suspected_quasi_afk_teammate: 'Possibile inattività di un compagno',
  opponent_quasi_afk: 'Possibile inattività di un avversario',
  caution_20_23: 'Durata di 20–23 minuti: dato da valutare con cautela',
  short_10_15: 'Partita breve: 10–15 minuti',
  short_15_20: 'Partita breve: 15–20 minuti',
  very_short: 'Partita molto breve',
  short_win_reduced: 'Vittoria breve con peso ridotto',
  surrender: 'Resa',
}

export function anomalyFlagsLabel(value: string | null | undefined) {
  if (!value?.trim()) return 'Nessuna anomalia'
  return value.split(/[;,]/).map((flag) => {
    const key = flag.trim().toLowerCase()
    return anomalyFlags[key] ?? flag.trim().replace(/_/g, ' ')
  }).filter(Boolean).join(' · ')
}

const modelDescriptions: Record<string, string> = {
  'profilo coerente con controllo e burst.': 'Profilo coerente con controllo e danni concentrati.',
  'prior teorico da verificare.': 'Ipotesi teorica da verificare.',
  'fit conservativo sotto soglia.': 'Compatibilità prudente sotto soglia.',
  'imported normalized match': 'Partita importata da dati normalizzati.',
  'victory evidence kept high': 'La vittoria mantiene un peso elevato nella valutazione.',
  'loss only partially attributed: duration or team-state leaves high causal uncertainty': 'Sconfitta attribuita solo in parte: la durata o la situazione della squadra rendono incerta la responsabilità del campione.',
  'victory retained; only anomalous conditions reduce its weight': 'La vittoria viene considerata; solo condizioni anomale ne riducono il peso.',
  'loss materially informative: playable duration with limited contamination': 'Sconfitta informativa: durata sufficiente e poche anomalie esterne.',
  'loss treated as almost non-informative due to short/remake/afk-like conditions': 'Sconfitta quasi priva di peso informativo: partita troppo breve, annullata o con possibile inattività.',
  'imported from riot match-v5; duration model v2': 'Dati importati da Riot; peso stimato in base alla durata (modello v2).',
  'imported from riot match-v5': 'Dati della partita importati da Riot.',
  'partita standard.': 'Partita senza anomalie rilevanti.',
  'unobserved/near-unobserved role option; ranked by tag overlap with observed positive evidence, not by match results.': 'Campione mai o quasi mai provato in questo ruolo. La posizione dipende dalle caratteristiche condivise con le scelte per cui hai dati positivi; non deriva dai risultati ottenuti con questo campione.',
  'negative corrected evidence; deprioritize unless new evidence contradicts it': 'I dati corretti indicano un rendimento negativo: riduci la priorità di questo campione finché nuove partite non mostrano un segnale diverso.',
  'repeated corrected negative evidence and poor opportunity cost': 'I dati corretti mostrano più volte un rendimento negativo e indicano alternative a cui dedicare le partite.',
}

/** Apply only to generated model descriptions, never to player names or notes. */
export function translateModelText(value: string) {
  const known = modelDescriptions[value.trim().toLowerCase()]
  if (known) return known
  return value
    .replace(/expected evidence\/game/gi, 'peso informativo atteso per partita')
    .replace(/role budget (\d+) from sqrt\(role exposure\)/gi, 'partite assegnate al ruolo: $1, in proporzione alla radice quadrata delle partite osservate nel ruolo')
    .replace(/block targets effective n/gi, 'obiettivo del ciclo: campione effettivo')
    .replace(/P\s*\(\s*high\s+fit\s*\)/gi, 'probabilità di compatibilità elevata')
    .replace(/\bVOI\b/gi, 'valore informativo')
    .replace(/\beffective\s+n\b/gi, 'campione effettivo')
    .replace(/THEORETICAL_SCREEN_ONLY/gi, 'solo valutazione teorica')
    .replace(/OBSERVED_FULL_EVIDENCE_BLOCK/gi, 'già osservato con dati completi')
    .replace(/EXTERNAL_TAGS_UNAVAILABLE/gi, 'caratteristiche non disponibili')
    .replace(/\bwin\s*rate\b/gi, 'percentuale di vittorie')
    .replace(/\b(i|dei|ai|sui|questi|alcuni) champion\b/gi, '$1 campioni')
    .replace(/\bchampions\b/gi, 'campioni')
    .replace(/\bchampion\b(?!\s+Fit)/gi, 'campione')
    .replace(/\bun game\b/gi, 'una partita')
    .replace(/\b(una|ogni|una sola|1) game\b/gi, '$1 partita')
    .replace(/\bgames?\b/gi, 'partite')
    .replace(/\bmatches\b/gi, 'partite')
    .replace(/\bmatch\b/gi, 'partita')
    .replace(/\b(le|delle|alle|sulle|queste|molte) loss\b/gi, '$1 sconfitte')
    .replace(/\blosses\b/gi, 'sconfitte')
    .replace(/\bloss\b/gi, 'sconfitta')
    .replace(/\bcarryable\b/gi, 'recuperabile')
    .replace(/\bgriefer\b/gi, 'giocatore che sabota')
    .replace(/annotazione manuale invincibile/gi, 'annotazione manuale di partita impossibile da vincere')
    .replace(/\binvincibile\b/gi, 'partita impossibile da vincere')
    .replace(/\bscope\b/gi, 'perimetro selezionato')
    .replace(/\bbaseline\b/gi, 'riferimento')
    .replace(/\bprior\b/gi, 'ipotesi iniziale')
    .replace(/(?<!champion )\bfit\b/gi, 'compatibilità')
    .replace(/\baudit\b/gi, 'revisione')
    .replace(/\b(TOP|JUNGLE|MIDDLE|BOTTOM|SUPPORT|UTILITY)\b/g, (role) => roleLabel(role).toLocaleLowerCase('it'))
}

const apiErrors: Record<string, string> = {
  'champion is required': 'Seleziona un campione.',
  'a valid role is required': 'Seleziona un ruolo valido.',
  'limit and offset must be integers': 'I parametri della pagina devono essere numeri interi.',
  'limit must be positive and offset non-negative': 'I parametri della pagina non sono validi.',
  'match_id is required': 'Seleziona una partita.',
  'unknown match_id': 'La partita selezionata non è stata trovata.',
  'endpoint not found': 'La risorsa richiesta non è disponibile.',
  'alias not found': 'Il nome alternativo non è stato trovato.',
  'group not found': 'Il gruppo non è stato trovato.',
  'invalid friend group resource': 'Il gruppo selezionato non è valido.',
  'invalid friend group': 'Il gruppo selezionato non è valido.',
  'invalid friend group name': 'Inserisci un nome valido per il gruppo.',
  'name is required': 'Inserisci un nome.',
  'name and at least one alias are required': 'Inserisci un nome e almeno un nome alternativo.',
  'scope non valido': 'La selezione dei dati non è valida.',
  'failed to fetch': 'Impossibile raggiungere il server. Riprova tra poco.',
  'internal server error': 'Il server ha riscontrato un errore. Riprova tra poco.',
  'service unavailable': 'Il servizio non è al momento disponibile. Riprova tra poco.',
  'not found': 'La risorsa richiesta non è stata trovata.',
  'bad request': 'La richiesta non è valida. Controlla i dati inseriti.',
  forbidden: 'Non hai accesso alla risorsa richiesta.',
  unauthorized: 'È necessario accedere per continuare.',
}

export function apiErrorLabel(value: string) {
  if (/^Error response\b/i.test(value)) return 'Il server non ha potuto completare la richiesta. Riprova tra poco.'
  return apiErrors[value.trim().toLowerCase()] ?? value
}
