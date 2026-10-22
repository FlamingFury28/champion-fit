import { stripPythonWhitespace } from './python-text'

// Keep this map aligned with playstyle_analysis.QUEUE_ALIASES. Source queue
// eligibility is a separate policy; it does not define accepted filter aliases.
const queueAliases: Record<string, string> = {
  NORMALDRAFT: '400',
  NORMAL_DRAFT: '400',
  DRAFTPICK: '400',
  RANKEDSOLO: '420',
  'RANKEDSOLO/DUO': '420',
  RANKED_SOLO_5X5: '420',
  RANKEDFLEX: '440',
  RANKED_FLEX_SR: '440',
  NORMALBLIND: '430',
  NORMAL_BLIND: '430',
  NORMAL_BLIND_PICK: '430',
  BLINDPICK: '430',
  QUICKPLAY: '490',
  NORMALQUICKPLAY: '490',
  NORMAL_QUICKPLAY: '490',
}

function canonicalQueueValue(value: string): string {
  const key = stripPythonWhitespace(value).toUpperCase().replaceAll(' ', '')
  return queueAliases[key] ?? (key.startsWith('QUEUE') ? key.slice(5) : key)
}

export function canonicalQueueFilter(value: string | null): string | null {
  // The common analysis layer recognizes only this exact aggregation sentinel.
  // Preserve omitted/empty inputs so each page retains its existing defaults.
  if (value === null || value === '' || value === 'all') return value
  const canonical = canonicalQueueValue(value)
  // A nonempty invalid filter must reach server validation. Sending an empty
  // value instead would omit the query parameter and silently apply a default.
  // The server canonicalizes again. A prefixed alias or repeated QUEUE prefix
  // must not become valid only because the client has removed one layer.
  return canonical && canonicalQueueValue(canonical) === canonical ? canonical : value
}
