import type { UpdateInfo } from 'builder-util-runtime'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'skipped'
  | 'not-available'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  version?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
  percent?: number
  error?: string
}

type ReleaseNotes = UpdateInfo['releaseNotes']

export function normalizeReleaseNotes(notes: ReleaseNotes): string | undefined {
  if (typeof notes === 'string') {
    const trimmed = notes.trim()
    return trimmed || undefined
  }

  if (!Array.isArray(notes)) return undefined

  const entries = notes
    .map((entry) => {
      const note = entry.note?.trim()
      if (!note) return ''
      return [`Version ${entry.version}`, note].join('\n')
    })
    .filter(Boolean)

  return entries.length > 0 ? entries.join('\n\n') : undefined
}

export function updateMetadata(info: UpdateInfo): Pick<UpdateState, 'version' | 'releaseName' | 'releaseDate' | 'releaseNotes'> {
  return {
    version: info.version,
    releaseName: info.releaseName?.trim() || undefined,
    releaseDate: info.releaseDate,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  }
}
