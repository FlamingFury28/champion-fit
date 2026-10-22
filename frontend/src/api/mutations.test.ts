import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { saveAnnotation, saveFriendGroup, saveRecommendationFeedback } from './mutations'
import type { AnnotationUpsertInput, FriendGroupDto, RecommendationFeedbackInputDto } from './types'

const annotationInput: AnnotationUpsertInput = {
  match_id: 'MATCH-ACK', invincible: false, carryable_loss: true, afk_player: false,
  griefer: false, team_collapse: false, manual_label: 'Équipe', note: 'Bozza 日本語 🎮',
  confidence: 0.8, expected_revision: 'revision-1',
}
const feedbackInput: RecommendationFeedbackInputDto = {
  accounts: ['Équipe#EUW'], champion: 'Ahri', role: 'MIDDLE', preference: 'like', expected_revision: 4,
}
const invalidResponseMessage = 'La risposta del server non è valida o completa. L’esito della richiesta non è confermato.'

function reply(payload: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(payload, { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function expectSinglePost(fetchMock: ReturnType<typeof reply>, path: string, input: unknown) {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({
    method: 'POST', body: JSON.stringify(input),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('acknowledgement dei salvataggi', () => {
  it('conferma una annotazione soltanto con ID e revisione validi', async () => {
    const acknowledgement = { ok: true, match_id: annotationInput.match_id, revision: 'revision-2' }
    const fetchMock = reply(acknowledgement)
    await expect(saveAnnotation(annotationInput)).resolves.toEqual(acknowledgement)
    expectSinglePost(fetchMock, '/api/annotations', annotationInput)
  })

  it.each([
    ['oggetto vuoto', {}],
    ['solo ok', { ok: true }],
    ['ok falso', { ok: false, match_id: 'MATCH-ACK', revision: 'revision-2' }],
    ['ok numerico', { ok: 1, match_id: 'MATCH-ACK', revision: 'revision-2' }],
    ['partita diversa', { ok: true, match_id: 'OTHER-MATCH', revision: 'revision-2' }],
    ['ID assente', { ok: true, revision: 'revision-2' }],
    ['revisione assente', { ok: true, match_id: 'MATCH-ACK' }],
    ['revisione nulla', { ok: true, match_id: 'MATCH-ACK', revision: null }],
    ['revisione numerica', { ok: true, match_id: 'MATCH-ACK', revision: 2 }],
    ['revisione vuota', { ok: true, match_id: 'MATCH-ACK', revision: '' }],
    ['revisione di soli spazi', { ok: true, match_id: 'MATCH-ACK', revision: '  ' }],
  ])('non conferma né ripete annotazione con %s', async (_case, payload) => {
    const fetchMock = reply(payload)
    await expect(saveAnnotation(annotationInput)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
    expectSinglePost(fetchMock, '/api/annotations', annotationInput)
  })

  it.each([
    ['scrittura', 4, 5],
    ['no-op', 4, 4],
    ['no-op iniziale', 0, 0],
  ])('accetta feedback %s senza imporre un incremento', async (_case, expectedRevision, revision) => {
    const input = { ...feedbackInput, expected_revision: expectedRevision }
    const acknowledgement = { ok: true, revision, items: [] }
    const fetchMock = reply(acknowledgement)
    await expect(saveRecommendationFeedback(input)).resolves.toEqual(acknowledgement)
    expectSinglePost(fetchMock, '/api/recommendation-feedback', input)
  })

  it('preserva gli elementi del ledger restituiti dal salvataggio', async () => {
    const acknowledgement = { ok: true, revision: 5, items: [{
      account: 'Équipe#EUW', champion: 'Ahri', role: 'MIDDLE', preference: 'like', updated_at: '2026-10-17T12:00:00Z',
    }] }
    const fetchMock = reply(acknowledgement)
    await expect(saveRecommendationFeedback(feedbackInput)).resolves.toEqual(acknowledgement)
    expectSinglePost(fetchMock, '/api/recommendation-feedback', feedbackInput)
  })

  it.each([
    ['oggetto vuoto', {}],
    ['solo ok', { ok: true }],
    ['ok falso', { ok: false, revision: 5, items: [] }],
    ['ok testuale', { ok: 'true', revision: 5, items: [] }],
    ['revisione assente', { ok: true, items: [] }],
    ['revisione nulla', { ok: true, revision: null, items: [] }],
    ['revisione testuale', { ok: true, revision: '5', items: [] }],
    ['revisione negativa', { ok: true, revision: -1, items: [] }],
    ['revisione frazionaria', { ok: true, revision: 4.5, items: [] }],
    ['revisione precedente', { ok: true, revision: 3, items: [] }],
    ['elementi assenti', { ok: true, revision: 5 }],
    ['elementi nulli', { ok: true, revision: 5, items: null }],
    ['elementi oggetto', { ok: true, revision: 5, items: {} }],
  ])('non conferma né ripete feedback con %s', async (_case, payload) => {
    const fetchMock = reply(payload)
    await expect(saveRecommendationFeedback(feedbackInput)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
    expectSinglePost(fetchMock, '/api/recommendation-feedback', feedbackInput)
  })

  it.each([
    ['annotazione', () => saveAnnotation(annotationInput), '/api/annotations', annotationInput],
    ['feedback', () => saveRecommendationFeedback(feedbackInput), '/api/recommendation-feedback', feedbackInput],
  ] as const)('propaga il conflitto %s senza ripetere il POST', async (_case, save, path, input) => {
    const fetchMock = reply({ error: 'Conflitto di revisione' }, 409)
    await expect(save()).rejects.toMatchObject({ name: 'ApiError', status: 409 })
    expectSinglePost(fetchMock, path, input)
  })
})

type GroupAction = Parameters<typeof saveFriendGroup>[0]

function groupCases(id: FriendGroupDto['id']): Array<{
  action: GroupAction; method: string; path: string; body?: unknown; acknowledgement: Record<string, unknown>
}> {
  return [
    { action: { kind: 'rename', id, name: 'Nuovo nome' }, method: 'PATCH', path: `/api/friend-groups/${id}`, body: { name: 'Nuovo nome' }, acknowledgement: { ok: true, id, name: 'Nuovo nome' } },
    { action: { kind: 'add-aliases', id, aliases: ['Altro#EUW'] }, method: 'POST', path: `/api/friend-groups/${id}/aliases`, body: { aliases: ['Altro#EUW'] }, acknowledgement: { ok: true, id, added_aliases: [] } },
    { action: { kind: 'delete-group', id }, method: 'DELETE', path: `/api/friend-groups/${id}`, acknowledgement: { ok: true, id } },
    { action: { kind: 'delete-alias', id, alias: 'Straße#EUW / 2' }, method: 'DELETE', path: `/api/friend-groups/${id}/aliases/Stra%C3%9Fe%23EUW%20%2F%202`, acknowledgement: { ok: true, id } },
  ]
}

function expectSingleGroupRequest(fetchMock: ReturnType<typeof reply>, method: string, path: string, body?: unknown) {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ method }))
  expect(fetchMock.mock.calls[0]?.[1].body).toBe(body === undefined ? undefined : JSON.stringify(body))
}

describe('acknowledgement dei gruppi', () => {
  it.each([' éQUIPE ', ' STRASSE '])('accetta creazione o riuso Unicode %s senza richiedere ID o nome persistito', async (name) => {
    const action = { kind: 'create' as const, name, aliases: ['Friend#EUW'] }
    const acknowledgement = { ok: true, name: name.trim() }
    const fetchMock = reply(acknowledgement)
    await expect(saveFriendGroup(action)).resolves.toEqual(acknowledgement)
    expectSingleGroupRequest(fetchMock, 'POST', '/api/friend-groups', { name, aliases: ['Friend#EUW'] })
  })

  describe.each([1, '9007199254740992', '9007199254740993', '9223372036854775807'])('ID esatto %s', (id) => {
    it.each(groupCases(id))('conferma $action.kind con una sola richiesta', async ({ action, method, path, body, acknowledgement }) => {
      const fetchMock = reply(acknowledgement)
      await expect(saveFriendGroup(action)).resolves.toEqual(acknowledgement)
      expectSingleGroupRequest(fetchMock, method, path, body)
    })
  })

  it('accetta il sottoinsieme di alias aggiunti senza inviare il metadato UI del gruppo', async () => {
    const action = { kind: 'add-aliases' as const, id: 1, groupName: 'Équipe', aliases: ['Esistente#EUW', 'Nuovo#EUW'] }
    const acknowledgement = { ok: true, id: 1, added_aliases: ['Nuovo#EUW'] }
    const fetchMock = reply(acknowledgement)
    await expect(saveFriendGroup(action)).resolves.toEqual(acknowledgement)
    expectSingleGroupRequest(fetchMock, 'POST', '/api/friend-groups/1/aliases', { aliases: action.aliases })
  })

  it.each([
    { action: { kind: 'create', name: 'Équipe', aliases: ['Friend#EUW'] } as GroupAction, method: 'POST', path: '/api/friend-groups', body: { name: 'Équipe', aliases: ['Friend#EUW'] }, acknowledgement: { ok: true, name: 'Équipe' } },
    ...groupCases('9223372036854775807'),
  ])('rifiuta oggetto vuoto o ok falso per $action.kind senza ripetere la richiesta', async ({ action, method, path, body, acknowledgement }) => {
    for (const payload of [{}, { ...acknowledgement, ok: false }]) {
      const fetchMock = reply(payload)
      await expect(saveFriendGroup(action)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
      expectSingleGroupRequest(fetchMock, method, path, body)
    }
  })

  it.each(groupCases('9007199254740993'))('rifiuta ID adiacente nella risposta $action.kind', async ({ action, method, path, body, acknowledgement }) => {
    const fetchMock = reply({ ...acknowledgement, id: '9007199254740992' })
    await expect(saveFriendGroup(action)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
    expectSingleGroupRequest(fetchMock, method, path, body)
  })

  it.each(groupCases('9007199254740992'))('rifiuta ID numerico non sicuro nella risposta $action.kind anche se appare uguale', async ({ action, method, path, body, acknowledgement }) => {
    // This raw ID rounds to the requested neighbor during JSON parsing.
    const raw = JSON.stringify(acknowledgement).replace('"id":"9007199254740992"', '"id":9007199254740993')
    const fetchMock = vi.fn().mockResolvedValue(new Response(raw, { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(saveFriendGroup(action)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
    expectSingleGroupRequest(fetchMock, method, path, body)
  })

  it.each([
    ['creazione senza nome', { kind: 'create', name: 'Équipe', aliases: ['Friend#EUW'] }, { ok: true }],
    ['creazione con nome diverso', { kind: 'create', name: 'équipe', aliases: ['Friend#EUW'] }, { ok: true, name: 'Équipe' }],
    ['rinomina con nome diverso', { kind: 'rename', id: 1, name: 'Straße' }, { ok: true, id: 1, name: 'STRASSE' }],
    ['ID assente', { kind: 'delete-group', id: 1 }, { ok: true }],
    ['ID frazionario', { kind: 'delete-group', id: 1 }, { ok: true, id: 1.5 }],
    ['ID booleano', { kind: 'delete-group', id: 1 }, { ok: true, id: true }],
    ['alias aggiunti assenti', { kind: 'add-aliases', id: 1, aliases: ['Friend#EUW'] }, { ok: true, id: 1 }],
    ['alias aggiunti nulli', { kind: 'add-aliases', id: 1, aliases: ['Friend#EUW'] }, { ok: true, id: 1, added_aliases: null }],
    ['alias aggiunti non array', { kind: 'add-aliases', id: 1, aliases: ['Friend#EUW'] }, { ok: true, id: 1, added_aliases: 'Friend#EUW' }],
    ['alias aggiunti non stringa', { kind: 'add-aliases', id: 1, aliases: ['Friend#EUW'] }, { ok: true, id: 1, added_aliases: [42] }],
  ] satisfies Array<[string, GroupAction, unknown]>)('rifiuta acknowledgement incompleto: %s', async (_case, action, acknowledgement) => {
    const fetchMock = reply(acknowledgement)
    await expect(saveFriendGroup(action)).rejects.toEqual(new ApiError(200, invalidResponseMessage))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
