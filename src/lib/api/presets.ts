import { apiFetch } from './client'
import type { StoryPresetMeta } from './types'

export const presets = {
  list: () =>
    apiFetch<{ presets: StoryPresetMeta[] }>('/presets'),
  get: (presetId: string) =>
    apiFetch<{ meta: StoryPresetMeta; bundle: Record<string, unknown> }>(`/presets/${presetId}`),
  create: (data: { name: string; description?: string; sourceStoryName?: string; bundle: Record<string, unknown> }) =>
    apiFetch<StoryPresetMeta>('/presets', { method: 'POST', body: JSON.stringify(data) }),
  update: (presetId: string, data: { name?: string; description?: string }) =>
    apiFetch<StoryPresetMeta>(`/presets/${presetId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (presetId: string) =>
    apiFetch<{ ok: boolean }>(`/presets/${presetId}`, { method: 'DELETE' }),
  apply: (presetId: string, storyId: string) =>
    apiFetch<{ fragments: unknown[]; count: number }>(`/presets/${presetId}/apply`, {
      method: 'POST',
      body: JSON.stringify({ storyId }),
    }),
}
