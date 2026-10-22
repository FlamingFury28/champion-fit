import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { useRememberedPlanBudget } from './remembered-plan-budget'

export function useOverviewBudget() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const { budget, rememberBudget, storageAvailable } = useRememberedPlanBudget(params)
  const [draft, setDraft] = useState({ key: location.key, value: String(budget) })
  if (draft.key !== location.key) setDraft({ key: location.key, value: String(budget) })
  const value = draft.key === location.key ? draft.value : String(budget)
  const setValue = (value: string) => setDraft({ key: location.key, value })
  const reset = () => setValue(String(budget))
  const commit = () => {
    const numeric = value.trim() ? Number(value) : Number.NaN
    const nextBudget = Number.isFinite(numeric) ? Math.min(2000, Math.max(20, Math.trunc(numeric))) : budget
    setValue(String(nextBudget))
    if (nextBudget === budget) return
    rememberBudget(nextBudget)
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.set('budget', String(nextBudget))
      return next
    }, { replace: true })
  }
  return { budget, value, setValue, commit, reset, storageAvailable }
}
