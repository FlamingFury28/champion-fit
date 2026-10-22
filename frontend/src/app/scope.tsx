import { useQuery } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { normalizeAccounts, sameAccounts, type CompanionFilterState, type ScopeSnapshot } from '../api/client'
import { accountsQuery } from '../api/queries'
import type { AccountDto } from '../api/types'
import { useAlgorithmSettings } from './algorithm-settings'

export const PROFILE_ACCOUNTS_KEY = 'champion-fit-profile-accounts'
export const PROFILE_GROUPS_KEY = 'champion-fit-profile-groups'
export const COMPANION_FILTER_KEY = 'champion-fit-companion-filter'

interface StoredCompanion {
  name?: string
  accounts?: unknown
  mode?: unknown
  profile_accounts?: unknown
}

export interface ScopeState {
  accounts: string[]
  profiles: Record<string, string[]>
  companion: CompanionFilterState | null
}

type ScopeAction =
  | { type: 'validate-accounts'; accounts: string[] }
  | { type: 'reconcile-identities'; availableAccounts: AccountDto[] }
  | { type: 'set-accounts'; accounts: string[] }
  | { type: 'save-profile'; name: string; accounts: string[] }
  | { type: 'delete-profile'; name: string }
  | { type: 'sync-profiles'; profiles: Record<string, string[]> }
  | { type: 'set-companion'; companion: CompanionFilterState }
  | { type: 'clear-companion' }

function readStorage(key: string): { value: string | null; available: boolean } {
  try {
    return { value: localStorage.getItem(key), available: true }
  } catch {
    return { value: null, available: false }
  }
}

function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(readStorage(key).value ?? 'null') as T | null
    return value ?? fallback
  } catch {
    return fallback
  }
}

function parseProfiles(value: string | null): Record<string, string[]> {
  try {
    const stored = JSON.parse(value ?? 'null') as unknown
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(
      Object.entries(stored as Record<string, unknown>)
        .filter(([, accounts]) => Array.isArray(accounts))
        .map(([name, accounts]) => [name, normalizeAccounts((accounts as unknown[]).map(String))]),
    )
  } catch {
    return {}
  }
}

function readProfiles(): Record<string, string[]> {
  return parseProfiles(readStorage(PROFILE_GROUPS_KEY).value)
}

function sameProfiles(left: Record<string, string[]>, right: Record<string, string[]>): boolean {
  const leftNames = Object.keys(left).sort((a, b) => a.localeCompare(b, 'it'))
  const rightNames = Object.keys(right).sort((a, b) => a.localeCompare(b, 'it'))
  return leftNames.length === rightNames.length
    && leftNames.every((name, index) => name === rightNames[index] && sameAccounts(left[name] ?? [], right[name] ?? []))
}

// Profiles are stored as a plain object for backwards compatibility. The last
// known browser value lets us apply independent edits from two tabs while a
// same-name edit remains an explicit local conflict winner.
export function mergeProfileChanges(
  local: Record<string, string[]>,
  incoming: Record<string, string[]>,
  baseline: Record<string, string[]>,
): Record<string, string[]> {
  const merged: [string, string[]][] = []
  const names = new Set([...Object.keys(local), ...Object.keys(incoming), ...Object.keys(baseline)])
  for (const name of names) {
    const current = Object.hasOwn(local, name) ? local[name] : undefined
    const remote = Object.hasOwn(incoming, name) ? incoming[name] : undefined
    const previous = Object.hasOwn(baseline, name) ? baseline[name] : undefined
    const localChanged = !sameAccounts(current ?? [], previous ?? []) || Boolean(current) !== Boolean(previous)
    const remoteChanged = !sameAccounts(remote ?? [], previous ?? []) || Boolean(remote) !== Boolean(previous)
    const selected = localChanged && remoteChanged && !sameAccounts(current ?? [], remote ?? [])
      ? current
      : localChanged ? current : remote
    if (selected) merged.push([name, normalizeAccounts(selected)])
  }
  return Object.fromEntries(merged)
}

function readCompanion(): CompanionFilterState | null {
  const stored = readJson<StoredCompanion | null>(COMPANION_FILTER_KEY, null)
  if (!stored || !Array.isArray(stored.accounts) || !Array.isArray(stored.profile_accounts)) return null
  if (stored.mode !== 'exclude' && stored.mode !== 'only') return null
  const accounts = normalizeAccounts(stored.accounts.map(String))
  if (!accounts.length) return null
  return {
    name: typeof stored.name === 'string' ? stored.name : 'profilo dei compagni',
    accounts,
    mode: stored.mode,
    profileAccounts: normalizeAccounts(stored.profile_accounts.map(String)),
  }
}

export function createInitialScopeState(): ScopeState {
  const storedAccounts = readJson<unknown>(PROFILE_ACCOUNTS_KEY, [])
  return {
    accounts: normalizeAccounts(Array.isArray(storedAccounts) ? storedAccounts.map(String) : []),
    profiles: readProfiles(),
    companion: readCompanion(),
  }
}

function riotIdKey(value: string): string {
  const separator = value.indexOf('#')
  if (separator < 0) return ''
  // Match common Unicode casefold differences without guessing unsupported
  // spellings: an unresolved alias remains an explicit filter.
  const fold = (part: string) => part.normalize('NFKC').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ς/g, 'σ')
  const name = fold(value.slice(0, separator))
  const tag = fold(value.slice(separator + 1))
  return name && tag ? `${name}#${tag}` : ''
}

function accountResolver(availableAccounts: AccountDto[]): (account: string) => string {
  const currentNames = new Set(availableAccounts.map((item) => item.account))
  const currentKeys = new Map<string, Set<string>>()
  const aliasKeys = new Map<string, Set<string>>()
  const add = (index: Map<string, Set<string>>, value: string, account: string) => {
    const key = riotIdKey(value)
    if (!key) return
    const owners = index.get(key) ?? new Set<string>()
    owners.add(account)
    index.set(key, owners)
  }
  for (const item of availableAccounts) {
    add(currentKeys, item.account, item.account)
    for (const alias of item.aliases ?? []) add(aliasKeys, alias, item.account)
  }
  return (account) => {
    if (currentNames.has(account)) return account
    const key = riotIdKey(account)
    const owners = currentKeys.get(key) ?? aliasKeys.get(key)
    return owners?.size === 1 ? owners.values().next().value ?? account : account
  }
}

export function resolveScopeIdentities(state: ScopeState, availableAccounts: AccountDto[]): ScopeState {
  const resolve = accountResolver(availableAccounts)
  const resolveNames = (names: string[]) => normalizeAccounts(names.map(resolve))
  // Unknown/ambiguous saved selections remain explicit filters. Only a truly
  // empty initial selection defaults to all accounts.
  const accounts = state.accounts.length
    ? resolveNames(state.accounts)
    : normalizeAccounts(availableAccounts.map((item) => item.account))
  const profiles = Object.fromEntries(
    Object.entries(state.profiles).map(([name, names]) => [name, resolveNames(names)]),
  )
  let companion = state.companion
  if (companion) {
    const profileAccounts = resolveNames(companion.profileAccounts)
    const companionAccounts = resolveNames(companion.accounts).filter((account) => !accounts.includes(account))
    companion = sameAccounts(profileAccounts, accounts) && companionAccounts.length
      ? { ...companion, accounts: companionAccounts, profileAccounts }
      : null
  }
  const sameProfiles = Object.entries(profiles).every(([name, names]) => sameAccounts(names, state.profiles[name] ?? []))
  const sameCompanion = companion === state.companion || Boolean(companion && state.companion
    && sameAccounts(companion.accounts, state.companion.accounts)
    && sameAccounts(companion.profileAccounts, state.companion.profileAccounts))
  return sameAccounts(accounts, state.accounts) && sameProfiles && sameCompanion
    ? state
    : { accounts, profiles, companion }
}

export function scopeReducer(state: ScopeState, action: ScopeAction): ScopeState {
  switch (action.type) {
    case 'reconcile-identities':
      return resolveScopeIdentities(state, action.availableAccounts)
    case 'validate-accounts': {
      const accounts = normalizeAccounts(action.accounts)
      const companion = state.companion && sameAccounts(state.companion.profileAccounts, accounts)
        ? state.companion
        : null
      return { ...state, accounts, companion }
    }
    case 'set-accounts': {
      const accounts = normalizeAccounts(action.accounts)
      if (sameAccounts(accounts, state.accounts)) return state
      return { ...state, accounts, companion: null }
    }
    case 'save-profile':
      return {
        ...state,
        profiles: { ...state.profiles, [action.name]: normalizeAccounts(action.accounts) },
      }
    case 'delete-profile': {
      const profiles = { ...state.profiles }
      delete profiles[action.name]
      return { ...state, profiles }
    }
    case 'sync-profiles':
      return sameProfiles(state.profiles, action.profiles) ? state : { ...state, profiles: action.profiles }
    case 'set-companion':
      return { ...state, companion: action.companion }
    case 'clear-companion':
      return { ...state, companion: null }
  }
}

export interface AccountSelectionResult {
  accounts: string[]
  appliedAccounts: string[]
  missing: string[]
  companionCleared: boolean
  changed: boolean
}

export interface CompanionSelectionResult {
  accounts: string[]
  missing: string[]
}

export interface ProfileSaveResult {
  name: string
  applied: boolean
  persisted: boolean
}

interface ScopeContextValue {
  state: ScopeState
  scope: ScopeSnapshot
  availableAccounts: AccountDto[]
  accountsLoading: boolean
  accountsError: Error | null
  scopeReady: boolean
  scopeEmpty: boolean
  storageAvailable: boolean
  algorithmSettingsLoading: boolean
  algorithmSettingsError: Error | null
  retryAccounts: () => void
  setAccounts: (accounts: string[]) => AccountSelectionResult
  saveProfile: (name: string, accounts?: string[]) => ProfileSaveResult
  deleteProfile: (name: string) => void
  setCompanion: (companion: Omit<CompanionFilterState, 'profileAccounts'>) => CompanionSelectionResult
  clearCompanion: () => void
}

const ScopeContext = createContext<ScopeContextValue | null>(null)

export function ScopeProvider({ children }: PropsWithChildren) {
  const algorithmSettings = useAlgorithmSettings()
  const [state, dispatch] = useReducer(scopeReducer, undefined, createInitialScopeState)
  const [storageState, setStorageState] = useState(() => ({
    profiles: readStorage(PROFILE_GROUPS_KEY).available,
    scope: readStorage(PROFILE_ACCOUNTS_KEY).available && readStorage(COMPANION_FILTER_KEY).available,
  }))
  const setStorageAvailable = useCallback((kind: keyof typeof storageState, available: boolean) => {
    setStorageState((current) => current[kind] === available ? current : { ...current, [kind]: available })
  }, [])
  const accounts = useQuery(accountsQuery)
  const availableAccounts = useMemo(() => accounts.data?.items ?? [], [accounts.data])
  const resolvedState = useMemo(
    () => accounts.data ? resolveScopeIdentities(state, availableAccounts) : state,
    [accounts.data, availableAccounts, state],
  )
  const resolvedAccounts = accounts.data ? resolvedState.accounts : []
  const stateRef = useRef(resolvedState)
  const profilesBaselineRef = useRef(state.profiles)
  // Validated account and settings snapshots survive background refresh
  // failures. Their revision stays explicit until a new snapshot is loaded.
  const algorithmSettingsError = algorithmSettings.data ? null : algorithmSettings.error
  const scopeReady = Boolean(
    accounts.data && availableAccounts.length > 0 && resolvedAccounts.length > 0
    && !algorithmSettings.isPending && !algorithmSettingsError,
  )

  useEffect(() => {
    if (!accounts.data) return
    if (resolvedState !== state) dispatch({ type: 'reconcile-identities', availableAccounts })
  }, [accounts.data, availableAccounts, resolvedState, state])

  useEffect(() => {
    stateRef.current = resolvedState
  }, [resolvedState])

  useEffect(() => {
    const stored = readStorage(PROFILE_GROUPS_KEY)
    if (!stored.available) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Browser persistence availability is known only after synchronizing with storage.
      setStorageAvailable('profiles', false)
      return
    }
    const storedProfiles = parseProfiles(stored.value)
    const nextProfiles = mergeProfileChanges(resolvedState.profiles, storedProfiles, profilesBaselineRef.current)
    const persisted = sameProfiles(storedProfiles, nextProfiles)
      || writeStorage(PROFILE_GROUPS_KEY, JSON.stringify(nextProfiles))
    profilesBaselineRef.current = persisted ? nextProfiles : storedProfiles
    setStorageAvailable('profiles', persisted)
    if (!sameProfiles(resolvedState.profiles, nextProfiles)) {
      dispatch({ type: 'sync-profiles', profiles: nextProfiles })
    }
  }, [resolvedState.profiles, setStorageAvailable])

  useEffect(() => {
    const syncProfiles = (event: StorageEvent) => {
      if (event.key !== PROFILE_GROUPS_KEY) return
      try {
        if (event.storageArea !== localStorage) return
      } catch {
        setStorageAvailable('profiles', false)
        return
      }
      const incoming = parseProfiles(event.newValue)
      const nextProfiles = mergeProfileChanges(stateRef.current.profiles, incoming, profilesBaselineRef.current)
      profilesBaselineRef.current = incoming
      if (!sameProfiles(stateRef.current.profiles, nextProfiles)) {
        dispatch({ type: 'sync-profiles', profiles: nextProfiles })
      }
    }
    window.addEventListener('storage', syncProfiles)
    return () => window.removeEventListener('storage', syncProfiles)
  }, [setStorageAvailable])

  useEffect(() => {
    const accountsPersisted = writeStorage(PROFILE_ACCOUNTS_KEY, JSON.stringify(resolvedState.accounts))
    const companionPersisted = writeStorage(COMPANION_FILTER_KEY, resolvedState.companion
      ? JSON.stringify({
        name: resolvedState.companion.name,
        accounts: resolvedState.companion.accounts,
        mode: resolvedState.companion.mode,
        profile_accounts: resolvedState.companion.profileAccounts,
      })
      : null)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Report browser write/remove failures while keeping the active session selection.
    setStorageAvailable('scope', accountsPersisted && companionPersisted)
  }, [resolvedState.accounts, resolvedState.companion, setStorageAvailable])

  const setAccounts = useCallback((next: string[]) => {
    const available = availableAccounts.map((item) => item.account)
    const requested = normalizeAccounts(next.map(accountResolver(availableAccounts)))
    const valid = available.length ? requested.filter((account) => available.includes(account)) : requested
    const missing = available.length ? requested.filter((account) => !available.includes(account)) : []
    if (available.length && !valid.length) {
      return { accounts: resolvedState.accounts, appliedAccounts: [], missing, companionCleared: false, changed: false }
    }
    const changed = !sameAccounts(valid, resolvedState.accounts)
    const companionCleared = changed && Boolean(resolvedState.companion)
    if (!changed) return { accounts: valid, appliedAccounts: valid, missing, companionCleared: false, changed: false }
    dispatch({ type: 'set-accounts', accounts: valid })
    return { accounts: valid, appliedAccounts: valid, missing, companionCleared, changed: true }
  }, [availableAccounts, resolvedState.accounts, resolvedState.companion])

  const saveProfile = useCallback((name: string, selected = resolvedState.accounts) => {
    const cleanName = name.trim().slice(0, 80)
    if (!cleanName || !selected.length) return { name: cleanName, applied: false, persisted: false }
    const selectedAccounts = normalizeAccounts(selected.map(accountResolver(availableAccounts)))
    const draft = { ...resolvedState.profiles, [cleanName]: selectedAccounts }
    const stored = readStorage(PROFILE_GROUPS_KEY)
    const merged = stored.available
      ? mergeProfileChanges(draft, parseProfiles(stored.value), profilesBaselineRef.current)
      : draft
    // An explicit save/overwrite must keep the submitted selection for this name.
    const profiles = { ...merged, [cleanName]: selectedAccounts }
    const persisted = stored.available && writeStorage(PROFILE_GROUPS_KEY, JSON.stringify(profiles))
    if (persisted) profilesBaselineRef.current = profiles
    setStorageAvailable('profiles', persisted)
    dispatch({ type: 'sync-profiles', profiles })
    return { name: cleanName, applied: true, persisted }
  }, [availableAccounts, resolvedState.accounts, resolvedState.profiles, setStorageAvailable])

  const setCompanion = useCallback((companion: Omit<CompanionFilterState, 'profileAccounts'>) => {
    const available = availableAccounts.map((item) => item.account)
    const requested = normalizeAccounts(companion.accounts.map(accountResolver(availableAccounts)))
    const catalogAccounts = available.length ? requested.filter((account) => available.includes(account)) : requested
    const missing = available.length ? requested.filter((account) => !available.includes(account)) : []
    const filtered = catalogAccounts.filter((account) => !resolvedState.accounts.includes(account))
    if (!filtered.length) return { accounts: [], missing }
    dispatch({
      type: 'set-companion',
      companion: { ...companion, accounts: filtered, profileAccounts: resolvedState.accounts },
    })
    return { accounts: filtered, missing }
  }, [availableAccounts, resolvedState.accounts])

  const value: ScopeContextValue = {
    state: resolvedState,
    scope: {
      accounts: resolvedAccounts,
      companion: resolvedState.companion,
      algorithmRevision: algorithmSettings.revision,
    },
    availableAccounts,
    accountsLoading: accounts.isPending,
    accountsError: accounts.data ? null : accounts.error,
    scopeReady,
    scopeEmpty: accounts.isSuccess && availableAccounts.length === 0,
    storageAvailable: storageState.profiles && storageState.scope,
    algorithmSettingsLoading: algorithmSettings.isPending,
    algorithmSettingsError,
    retryAccounts: () => { void accounts.refetch() },
    setAccounts,
    saveProfile,
    deleteProfile: (name) => dispatch({ type: 'delete-profile', name }),
    setCompanion,
    clearCompanion: () => dispatch({ type: 'clear-companion' }),
  }

  return <ScopeContext value={value}>{children}</ScopeContext>
}

export function useScope() {
  const context = useContext(ScopeContext)
  if (!context) throw new Error('useScope deve essere usato dentro ScopeProvider')
  return context
}
