import { useState } from 'react'
import { clampInteger } from './filters'

export const PLAN_BUDGET_KEY = 'champion-fit:plan-budget:v1'
export const COMPETITIVE_PLAN_FILTERS_KEY = 'champion-fit:competitive-plan-filters:v1'
// The competitive plan has its own backend default, separate from the short
// training-cycle setting. A saved preference never changes that configuration.
export const DEFAULT_PLAN_BUDGET = 400
const contextKeys = ['budget', 'n', 'role', 'queue', 'days']

function validBudget(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 20 && Number(value) <= 2000
}

function readPreference() {
  try {
    const current = localStorage.getItem(PLAN_BUDGET_KEY)
    if (validBudget(current)) return { budget: Number(current), storageAvailable: true }
    // Existing users already have a chosen budget inside the plan filters.
    // Reuse it without writing storage merely because a link was opened.
    let legacy: unknown
    try { legacy = JSON.parse(localStorage.getItem(COMPETITIVE_PLAN_FILTERS_KEY) ?? 'null') }
    catch { legacy = null }
    const oldBudget = legacy && typeof legacy === 'object' && !Array.isArray(legacy)
      ? (legacy as Record<string, unknown>).budget : null
    return { budget: validBudget(oldBudget) ? Number(oldBudget) : DEFAULT_PLAN_BUDGET, storageAvailable: true }
  } catch { return { budget: DEFAULT_PLAN_BUDGET, storageAvailable: false } }
}

export function useRememberedPlanBudget(params: URLSearchParams) {
  const [saved, setSaved] = useState(readPreference)
  // A context-bearing link remains self-contained, including when its budget
  // is omitted. Opening it must not overwrite the browser's own preference.
  const budget = contextKeys.some((key) => params.has(key))
    ? clampInteger(params.get('budget') ?? params.get('n'), 20, 2000, DEFAULT_PLAN_BUDGET)
    : saved.budget

  function rememberBudget(value: number) {
    if (!Number.isInteger(value) || value < 20 || value > 2000) return
    let storageAvailable = true
    try { localStorage.setItem(PLAN_BUDGET_KEY, String(value)) }
    catch { storageAvailable = false }
    setSaved({ budget: value, storageAvailable })
  }

  return { budget, rememberBudget, storageAvailable: saved.storageAvailable }
}
