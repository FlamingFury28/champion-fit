import { queryOptions } from '@tanstack/react-query'
import { ApiError, getJson, postJson } from './client'

interface Counts { planned: number; completed: number; remaining: number; extra: number }
export interface TrainingProgress extends Counts {
  id: string
  fingerprint: string
  started_at: string
  budget_total: number
  queue: string
  accounts: string[]
  companions: string[]
  companion_mode: string
  unavailable_accounts: string[]
  companion_unavailable: boolean
  items: (Counts & { champion: string; role: string; accounts: (Counts & { account: string })[] })[]
}
export interface StartPlanInput { id: string; fingerprint: string; params: Record<string, string[]> }
export const validPlanId = (value: string | null): value is string => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
export const trainingProgressKey = (id: string) => ['api', 'training-progress', id] as const

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')
const counts = (value: unknown): value is Counts => object(value)
  && ['planned', 'completed', 'remaining', 'extra'].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
  && Number(value.completed) + Number(value.remaining) === value.planned

function validate(value: unknown, id: string): TrainingProgress {
  if (!object(value) || value.id !== id || !counts(value) || typeof value.started_at !== 'string' || !Number.isFinite(Date.parse(value.started_at))
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || typeof value.queue !== 'string' || !strings(value.accounts) || !strings(value.companions)
    || typeof value.companion_mode !== 'string' || !strings(value.unavailable_accounts) || typeof value.companion_unavailable !== 'boolean'
    || !Number.isSafeInteger(value.budget_total) || Number(value.budget_total) < value.planned
    || !Array.isArray(value.items) || !value.items.every((item) => object(item) && counts(item) && typeof item.champion === 'string' && typeof item.role === 'string'
      && Array.isArray(item.accounts) && item.accounts.every((entry: unknown) => object(entry) && counts(entry) && typeof entry.account === 'string'))) {
    throw new ApiError(502, 'La risposta del piano non è completa. Riprova per confermare il salvataggio e i conteggi.')
  }
  return value as unknown as TrainingProgress
}

export const trainingProgressQuery = (id: string) => queryOptions({
  queryKey: trainingProgressKey(id),
  queryFn: async ({ signal }) => validate(await getJson('/api/training-progress', { id }, signal), id),
  enabled: validPlanId(id),
  retry: false,
})

export async function startTrainingPlan(input: StartPlanInput) {
  const result = validate(await postJson('/api/training-progress', input), input.id)
  if (result.fingerprint !== input.fingerprint) throw new ApiError(502, 'Il server non ha confermato il piano scelto. Riprova.')
  return result
}
