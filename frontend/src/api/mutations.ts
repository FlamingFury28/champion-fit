import { ApiError, deleteJson, patchJson, postJson } from './client'
import type {
  AnnotationMutationResponseDto,
  AnnotationUpsertInput,
  FriendGroupDto,
  FriendGroupMutationResponseDto,
  RecommendationFeedbackInputDto,
  RecommendationFeedbackMutationResponseDto,
} from './types'

type FriendGroupAction =
  | { kind: 'create'; name: string; aliases: string[] }
  | { kind: 'rename'; id: FriendGroupDto['id']; name: string }
  | { kind: 'add-aliases'; id: FriendGroupDto['id']; aliases: string[] }
  | { kind: 'delete-group'; id: FriendGroupDto['id'] }
  | { kind: 'delete-alias'; id: FriendGroupDto['id']; alias: string }

const invalidResponseMessage = 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAnnotationAcknowledgement(value: unknown, matchId: string): value is AnnotationMutationResponseDto {
  return isObject(value) && value.ok === true && value.match_id === matchId
    && typeof value.revision === 'string' && value.revision.trim().length > 0
}

function isFeedbackAcknowledgement(value: unknown, expectedRevision: number): value is RecommendationFeedbackMutationResponseDto {
  return isObject(value) && value.ok === true
    && typeof value.revision === 'number' && Number.isInteger(value.revision)
    && value.revision >= 0 && value.revision >= expectedRevision && Array.isArray(value.items)
}

function isFriendGroupId(value: unknown): value is FriendGroupDto['id'] {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

function isFriendGroupAcknowledgement(value: unknown, action: FriendGroupAction): value is FriendGroupMutationResponseDto {
  if (!isObject(value) || value.ok !== true) return false
  if (action.kind === 'create') return value.name === action.name.trim()
  if (!isFriendGroupId(value.id) || !isFriendGroupId(action.id) || String(value.id) !== String(action.id)) return false
  if (action.kind === 'rename') return value.name === action.name.trim()
  if (action.kind === 'add-aliases') return Array.isArray(value.added_aliases)
    && value.added_aliases.every((alias: unknown) => typeof alias === 'string')
  return true
}

export async function saveAnnotation(input: AnnotationUpsertInput): Promise<AnnotationMutationResponseDto> {
  const saved = await postJson<unknown>('/api/annotations', input)
  if (!isAnnotationAcknowledgement(saved, input.match_id)) throw new ApiError(200, invalidResponseMessage)
  return saved
}

export async function saveRecommendationFeedback(input: RecommendationFeedbackInputDto): Promise<RecommendationFeedbackMutationResponseDto> {
  const saved = await postJson<unknown>('/api/recommendation-feedback', input)
  if (!isFeedbackAcknowledgement(saved, input.expected_revision)) throw new ApiError(200, invalidResponseMessage)
  return saved
}

export async function saveFriendGroup(action: FriendGroupAction): Promise<FriendGroupMutationResponseDto> {
  let saved: unknown
  if (action.kind === 'create') saved = await postJson<unknown>('/api/friend-groups', { name: action.name, aliases: action.aliases })
  else if (action.kind === 'rename') saved = await patchJson<unknown>(`/api/friend-groups/${action.id}`, { name: action.name })
  else if (action.kind === 'add-aliases') saved = await postJson<unknown>(`/api/friend-groups/${action.id}/aliases`, { aliases: action.aliases })
  else if (action.kind === 'delete-alias') saved = await deleteJson<unknown>(`/api/friend-groups/${action.id}/aliases/${encodeURIComponent(action.alias)}`)
  else saved = await deleteJson<unknown>(`/api/friend-groups/${action.id}`)
  if (!isFriendGroupAcknowledgement(saved, action)) throw new ApiError(200, invalidResponseMessage)
  return saved
}
