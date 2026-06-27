import { describe, expect, it } from 'vitest'
import {
  parseHeaderAspect,
  resolveHeaderImage,
  headerFocalPosition,
  parseHeaderFade,
  DEFAULT_HEADER_ASPECT,
  HEADER_ASPECT_RATIOS,
} from '@/lib/fragment-visuals'
import type { Fragment } from '@/lib/api'

function makeFragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: 'pr-abcd',
    type: 'prose',
    name: '',
    description: '',
    content: '',
    tags: [],
    refs: [],
    sticky: false,
    placement: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    order: 0,
    meta: {},
    archived: false,
    ...overrides,
  }
}

describe('parseHeaderAspect', () => {
  it('falls back to the default when unset', () => {
    expect(parseHeaderAspect(undefined)).toBe(DEFAULT_HEADER_ASPECT)
    expect(parseHeaderAspect({})).toBe(DEFAULT_HEADER_ASPECT)
  })

  it('accepts a known aspect id', () => {
    expect(parseHeaderAspect({ headerAspect: '16:9' })).toBe('16:9')
    expect(parseHeaderAspect({ headerAspect: 'original' })).toBe('original')
  })

  it('rejects unknown or malformed values', () => {
    expect(parseHeaderAspect({ headerAspect: '4:3' })).toBe(DEFAULT_HEADER_ASPECT)
    expect(parseHeaderAspect({ headerAspect: 42 })).toBe(DEFAULT_HEADER_ASPECT)
  })

  it('defaults to the cinematic 21:9 plate', () => {
    expect(DEFAULT_HEADER_ASPECT).toBe('21:9')
    expect(HEADER_ASPECT_RATIOS[0].id).toBe('21:9')
  })
})

describe('resolveHeaderImage', () => {
  const image = makeFragment({
    id: 'im-pic1',
    type: 'image',
    name: 'Harbor at dusk',
    content: 'https://example.com/harbor.jpg',
  })
  const mediaById = new Map<string, Fragment>([[image.id, image]])

  it('returns null when the prose has no visual refs', () => {
    expect(resolveHeaderImage(makeFragment(), mediaById)).toBeNull()
  })

  it('resolves the first image-kind ref to url + name + boundary', () => {
    const prose = makeFragment({
      meta: { visualRefs: [{ fragmentId: 'im-pic1', kind: 'image', boundary: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } }] },
    })
    expect(resolveHeaderImage(prose, mediaById)).toEqual({
      imageUrl: 'https://example.com/harbor.jpg',
      name: 'Harbor at dusk',
      boundary: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 },
    })
  })

  it('ignores icon-only refs (headers want a real image)', () => {
    const prose = makeFragment({ meta: { visualRefs: [{ fragmentId: 'ic-x', kind: 'icon' }] } })
    expect(resolveHeaderImage(prose, mediaById)).toBeNull()
  })

  it('returns null when the referenced media is missing or has no url', () => {
    const missing = makeFragment({ meta: { visualRefs: [{ fragmentId: 'im-gone', kind: 'image' }] } })
    expect(resolveHeaderImage(missing, mediaById)).toBeNull()

    const empty = makeFragment({ id: 'im-empty', type: 'image', content: '   ' })
    const prose = makeFragment({ meta: { visualRefs: [{ fragmentId: 'im-empty', kind: 'image' }] } })
    expect(resolveHeaderImage(prose, new Map([[empty.id, empty]]))).toBeNull()
  })
})

describe('parseHeaderFade', () => {
  it('defaults to false', () => {
    expect(parseHeaderFade(undefined)).toBe(false)
    expect(parseHeaderFade({})).toBe(false)
  })

  it('is true only for an explicit boolean true', () => {
    expect(parseHeaderFade({ headerFade: true })).toBe(true)
    expect(parseHeaderFade({ headerFade: false })).toBe(false)
    expect(parseHeaderFade({ headerFade: 'true' })).toBe(false)
  })
})

describe('headerFocalPosition', () => {
  it('centers when there is no crop boundary', () => {
    expect(headerFocalPosition(undefined)).toBe('50% 50%')
  })

  it('focuses on the center of the crop region', () => {
    expect(headerFocalPosition({ x: 0.2, y: 0.4, width: 0.4, height: 0.2 })).toBe('40% 50%')
  })

  it('clamps focal point into [0, 100]%', () => {
    expect(headerFocalPosition({ x: 0.9, y: 0, width: 0.4, height: 0.4 })).toBe('100% 20%')
  })
})
