import type { TrainingProgress } from '../api/training-progress'

/** Follow the saved allocation, independent of the current preview and its filters. */
export function nextPlannedGame(progress: TrainingProgress) {
  if (progress.remaining === 0 || progress.companion_unavailable || progress.unavailable_accounts.length) return null
  const candidates = progress.items.flatMap((item) => {
    if (item.remaining <= 0) return []
    const account = item.accounts.filter((entry) => entry.remaining > 0 && progress.accounts.includes(entry.account))
      .sort((left, right) => right.remaining - left.remaining || left.account.localeCompare(right.account, 'it'))[0]
    return account ? [{ champion: item.champion, role: item.role, remaining: item.remaining,
      account: account.account, accountRemaining: account.remaining }] : []
  })
  return candidates.sort((left, right) => right.remaining - left.remaining
    || left.champion.localeCompare(right.champion, 'it') || left.role.localeCompare(right.role, 'it'))[0] ?? null
}
