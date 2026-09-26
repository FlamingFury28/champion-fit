import { useEffect, useState } from 'react'

export const ROLES = ['ALL', 'TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT'] as const

export function normalizeRole(value: string | null): string {
  const normalized = value?.toUpperCase() === 'UTILITY' ? 'SUPPORT' : value?.toUpperCase()
  return ROLES.includes(normalized as typeof ROLES[number]) ? normalized! : 'ALL'
}

export function clampInteger(value: string | null, minimum: number, maximum: number, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

export function useDebouncedValue<T>(value: T, delay = 180) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])
  return debounced
}

export function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleDateString('it-IT')
}

export function pct(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${new Intl.NumberFormat('it-IT', { maximumFractionDigits: digits }).format(value)}%`
}

export function fitStatus(item: {
  record_kind: string
  validated_positive: 0 | 1
  blacklist_strong: 0 | 1
  blacklist_provisional: 0 | 1
  allocated_games: number
  actionable?: boolean
}) {
  if (item.record_kind === 'screen') return { label: 'Valutazione preliminare', tone: 'info' as const }
  if (item.record_kind === 'account') return item.actionable
    ? { label: 'Vantaggio supportato', tone: 'positive' as const }
    : { label: 'Da verificare', tone: 'warning' as const }
  if (item.blacklist_strong) return { label: 'Pausa consigliata', tone: 'negative' as const }
  if (item.blacklist_provisional) return { label: 'Segnale da verificare', tone: 'warning' as const }
  if (item.validated_positive) return { label: 'Validato', tone: 'positive' as const }
  if (item.allocated_games > 0) return { label: 'In prova', tone: 'info' as const }
  return { label: 'Osservato', tone: 'neutral' as const }
}
