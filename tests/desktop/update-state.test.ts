import { describe, expect, it } from 'vitest'
import { normalizeReleaseNotes, updateMetadata } from '../../desktop/update-state'

describe('desktop update state', () => {
  it('keeps string release notes as the changelog text', () => {
    expect(normalizeReleaseNotes('\nFixed update panel.\n')).toBe('Fixed update panel.')
  })

  it('formats full changelog release-note arrays', () => {
    expect(normalizeReleaseNotes([
      { version: '1.9.7', note: 'Added update changelog.' },
      { version: '1.9.6', note: 'Manual update checks.' },
      { version: '1.9.5', note: null },
    ])).toBe('Version 1.9.7\nAdded update changelog.\n\nVersion 1.9.6\nManual update checks.')
  })

  it('extracts version metadata from update info', () => {
    expect(updateMetadata({
      version: '1.9.7',
      files: [],
      path: '',
      sha512: '',
      releaseName: 'Errata 1.9.7',
      releaseDate: '2026-06-08T00:00:00.000Z',
      releaseNotes: 'Changelog',
    })).toEqual({
      version: '1.9.7',
      releaseName: 'Errata 1.9.7',
      releaseDate: '2026-06-08T00:00:00.000Z',
      releaseNotes: 'Changelog',
    })
  })
})
