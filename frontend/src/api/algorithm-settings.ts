import { ApiError, getJson, postJson, putJson, type QueryInput } from './client'
import type {
  AlgorithmPreviewResponseDto,
  AlgorithmSettingSchemaDto,
  AlgorithmSettings,
  AlgorithmSettingsHistoryDto,
  AlgorithmSettingsResponseDto,
} from './types'

interface SettingsInput { expected_revision: number; settings: AlgorithmSettings }
interface PreviewInput extends SettingsInput { scope: QueryInput; filters: QueryInput }

const invalidResponseMessage = 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRevision(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function isOptionValue(value: unknown) {
  return typeof value === 'string' || isNumber(value)
}

function isSchemaField(value: unknown): value is AlgorithmSettingSchemaDto {
  if (!isRecord(value) || !['path', 'label', 'description', 'type', 'group'].every((key) => typeof value[key] === 'string')) return false
  // The backend emits null for absent bounds/options; retain that wire shape.
  if (value.min != null && !isNumber(value.min)) return false
  if (value.max != null && !isNumber(value.max)) return false
  return value.options == null || (Array.isArray(value.options) && value.options.every((option: unknown) =>
    isOptionValue(option) || (isRecord(option) && typeof option.label === 'string' && isOptionValue(option.value))))
}

function isHistoryItem(value: unknown): value is AlgorithmSettingsHistoryDto {
  if (!isRecord(value)) return false
  if (value.revision !== undefined && !isRevision(value.revision)) return false
  if (!['fingerprint', 'created_at', 'summary'].every((key) => value[key] === undefined || typeof value[key] === 'string')) return false
  if (value.changed_paths !== undefined && !isStringArray(value.changed_paths)) return false
  // Archived settings can predate fields in the current schema.
  return value.settings === undefined || isRecord(value.settings)
}

function pathValue(root: Record<string, unknown>, path: string): { value: unknown } | null {
  let value: unknown = root
  for (const key of path.split('.')) {
    if (!key || !isRecord(value) || !Object.hasOwn(value, key)) return null
    value = value[key]
  }
  return { value }
}

function matchesFieldType(value: unknown, type: string) {
  if (type === 'number') return isNumber(value)
  if (type === 'integer') return isNumber(value) && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'string') return typeof value === 'string'
  if (type === 'number[]') return Array.isArray(value) && value.every(isNumber)
  if (type === 'string[]') return isStringArray(value)
  if (type === 'select') return isOptionValue(value)
  if (type === 'period') return isRecord(value) && typeof value.value === 'number' && Number.isSafeInteger(value.value)
    && (value.unit === 'days' || value.unit === 'games')
  return true
}

function isSnapshot(value: unknown): value is AlgorithmSettingsResponseDto {
  if (!isRecord(value)) return false
  const { revision, fingerprint, settings, defaults, schema, history } = value
  if (!isRevision(revision) || !isFingerprint(fingerprint) || !isNonEmptyRecord(settings) || !isNonEmptyRecord(defaults)) return false
  if (!Array.isArray(schema) || !schema.every(isSchemaField) || !Array.isArray(history) || !history.every(isHistoryItem)) return false
  return schema.every((field) => [settings, defaults].every((root) => {
    const found = pathValue(root, field.path)
    return found !== null && matchesFieldType(found.value, field.type)
  }))
}

function decodeSnapshot(value: unknown): AlgorithmSettingsResponseDto {
  if (!isSnapshot(value)) throw new ApiError(200, invalidResponseMessage)
  return value
}

function isPreview(value: unknown, expectedRevision: number): value is AlgorithmPreviewResponseDto {
  return isRecord(value) && isRevision(value.base_revision) && value.base_revision === expectedRevision
    && isFingerprint(value.proposed_fingerprint) && isStringArray(value.changed_paths)
    && Array.isArray(value.comparisons) && value.comparisons.every((item: unknown) => isRecord(item)
      && typeof item.algorithm === 'string' && Object.hasOwn(item, 'before') && Object.hasOwn(item, 'after'))
    && Array.isArray(value.sensitivity) && isRecord(value.context) && isStringArray(value.notes)
}

export async function getAlgorithmSettings(signal?: AbortSignal): Promise<AlgorithmSettingsResponseDto> {
  return decodeSnapshot(await getJson<unknown>('/api/algorithm-settings', undefined, signal))
}

export async function saveAlgorithmSettings(input: SettingsInput): Promise<AlgorithmSettingsResponseDto> {
  const saved = decodeSnapshot(await putJson<unknown>('/api/algorithm-settings', input))
  if (saved.revision <= input.expected_revision) throw new ApiError(200, invalidResponseMessage)
  return saved
}

export async function previewAlgorithmSettings(input: PreviewInput, signal?: AbortSignal): Promise<AlgorithmPreviewResponseDto> {
  const preview = await postJson<unknown>('/api/algorithm-settings/preview', input, signal)
  if (!isPreview(preview, input.expected_revision)) throw new ApiError(200, invalidResponseMessage)
  return preview
}
