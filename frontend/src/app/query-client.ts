import { QueryCache, QueryClient } from '@tanstack/react-query'
import { getAlgorithmSettings } from '../api/algorithm-settings'
import { ApiError } from '../api/client'

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (!(error instanceof ApiError) || error.status !== 409) return
      if (query.queryKey[0] !== 'api' || query.queryKey[1] === 'algorithm-settings') return
      void queryClient.fetchQuery({
        queryKey: ['api', 'algorithm-settings'],
        queryFn: ({ signal }) => getAlgorithmSettings(signal),
        staleTime: 0,
        retry: false,
      }).catch(() => undefined)
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: (failureCount, error) => !(error instanceof ApiError && (error.status === 400 || error.status === 409)) && failureCount < 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
})
