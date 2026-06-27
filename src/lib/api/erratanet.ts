import { apiFetch } from './client'
import type { ErratapackManifest } from '../erratanet/pack-schema'
import type {
  AgentConfigApplyResponse,
  AgentConfigInclude,
  AgentConfigInspectResponse,
  AgentConfigSelection,
  AgentConfigSnapshotResponse,
  AgentPresetDetailResponse,
  AgentPresetListResponse,
  AgentPresetSummary,
  ErratanetAccount,
  ErratanetConfigResponse,
  ErratanetInstallResponse,
  ErratanetPackDetail,
  ErratanetPublishResponse,
  ErratanetSearchResponse,
  ErratanetUpdatesResponse,
} from './types'

export const erratanet = {
  getConfig: () => apiFetch<ErratanetConfigResponse>('/erratanet/config'),
  setConfig: (data: { hubUrl?: string; token?: string; enabled?: boolean; introSeen?: boolean }) =>
    apiFetch<ErratanetConfigResponse>('/erratanet/config', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getAccount: () => apiFetch<ErratanetAccount>('/erratanet/account'),
  login: (body: { hubUrl: string; identifier: string; password: string }) =>
    apiFetch<ErratanetAccount>('/erratanet/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  search: (q: string) =>
    apiFetch<ErratanetSearchResponse>(`/erratanet/search?q=${encodeURIComponent(q)}`),
  getPack: (id: string, version?: string) =>
    apiFetch<ErratanetPackDetail>(
      `/erratanet/packs/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ''}`,
    ),
  publish: (body: {
    bundleJson?: string
    storyId?: string
    /** For a fragment pack published from a story: the fragments it contains. */
    fragmentIds?: string[]
    unlisted?: boolean
    manifest: ErratapackManifest
  }) =>
    apiFetch<ErratanetPublishResponse>('/erratanet/publish', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  install: (body: { id: string; version?: string; targetStoryId?: string; asNewStory?: boolean }) =>
    apiFetch<ErratanetInstallResponse>('/erratanet/install', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  checkUpdates: (storyId: string) =>
    apiFetch<ErratanetUpdatesResponse>(
      `/erratanet/updates?storyId=${encodeURIComponent(storyId)}`,
    ),

  /** Agent-configuration sharing: snapshot, publish, inspect, apply, presets. */
  agentConfig: {
    snapshot: (storyId: string, includes?: AgentConfigInclude[]) =>
      apiFetch<AgentConfigSnapshotResponse>('/erratanet/agent-config/snapshot', {
        method: 'POST',
        body: JSON.stringify({ storyId, ...(includes ? { includes } : {}) }),
      }),
    publish: (body: {
      storyId: string
      includes?: AgentConfigInclude[]
      selection?: AgentConfigSelection
      unlisted?: boolean
      manifest: ErratapackManifest
    }) =>
      apiFetch<ErratanetPublishResponse>('/erratanet/agent-config/publish', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    inspect: (id: string, version?: string) =>
      apiFetch<AgentConfigInspectResponse>('/erratanet/agent-config/inspect', {
        method: 'POST',
        body: JSON.stringify({ id, ...(version ? { version } : {}) }),
      }),
    apply: (body: {
      id: string
      version?: string
      selection?: AgentConfigSelection
      consentToScripts?: boolean
      applyToStoryId?: string
      savePreset?: { name: string }
    }) =>
      apiFetch<AgentConfigApplyResponse>('/erratanet/agent-config/apply', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  /** Saved, story-independent agent-config presets. */
  presets: {
    list: () => apiFetch<AgentPresetListResponse>('/erratanet/agent-presets'),
    get: (id: string) =>
      apiFetch<AgentPresetDetailResponse>(`/erratanet/agent-presets/${encodeURIComponent(id)}`),
    save: (body: { name: string; fromStoryId?: string; includes?: AgentConfigInclude[] }) =>
      apiFetch<{ id: string; name: string; summary: AgentPresetSummary['summary'] }>(
        '/erratanet/agent-presets',
        { method: 'POST', body: JSON.stringify(body) },
      ),
    remove: (id: string) =>
      apiFetch<{ ok: boolean }>(`/erratanet/agent-presets/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    apply: (id: string, body: { storyId: string; consentToScripts?: boolean }) =>
      apiFetch<AgentConfigApplyResponse>(
        `/erratanet/agent-presets/${encodeURIComponent(id)}/apply`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
  },
}
