import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { ProseImageHeader } from '@/components/prose/ProseImageHeader'
import type { Fragment } from '@/lib/api'
import type { HeaderImage } from '@/lib/fragment-visuals'

function makeFragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: 'pr-abcd',
    type: 'prose',
    name: '',
    description: '',
    content: 'Once upon a time.',
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

function render(ui: ReactElement): string {
  const client = new QueryClient()
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, ui))
}

const header: HeaderImage = {
  imageUrl: 'https://example.com/harbor.jpg',
  name: 'Harbor at dusk',
}

describe('ProseImageHeader', () => {
  it('renders the image with alt text from the media name', () => {
    const html = render(
      createElement(ProseImageHeader, { storyId: 's1', fragment: makeFragment(), header }),
    )
    expect(html).toContain('src="https://example.com/harbor.jpg"')
    expect(html).toContain('alt="Harbor at dusk"')
  })

  it('offers all aspect-ratio options plus a fade toggle in an accessible group', () => {
    const html = render(
      createElement(ProseImageHeader, { storyId: 's1', fragment: makeFragment(), header }),
    )
    expect(html).toContain('aria-label="Header image display"')
    for (const label of ['21:9', '16:9', '3:2', '1:1', 'Full', 'Fade']) {
      expect(html).toContain(`>${label}</button>`)
    }
  })

  it('keeps fade off by default — no mask, toggle unpressed', () => {
    const html = render(
      createElement(ProseImageHeader, { storyId: 's1', fragment: makeFragment(), header }),
    )
    expect(html).not.toContain('mask-image')
    expect(html).toMatch(/aria-pressed="false"[^>]*>Fade<\/button>/)
  })

  it('masks the image and presses the toggle when fade is stored', () => {
    const html = render(
      createElement(ProseImageHeader, {
        storyId: 's1',
        fragment: makeFragment({ meta: { headerFade: true } }),
        header,
      }),
    )
    expect(html).toContain('mask-image:linear-gradient')
    expect(html).toMatch(/aria-pressed="true"[^>]*>Fade<\/button>/)
  })

  it('marks the default cinematic plate as selected when unset', () => {
    const html = render(
      createElement(ProseImageHeader, { storyId: 's1', fragment: makeFragment(), header }),
    )
    // exactly one pressed option, and it is the 21:9 default
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1)
    expect(html).toMatch(/aria-pressed="true"[^>]*>21:9<\/button>/)
  })

  it('reflects a stored aspect choice', () => {
    const html = render(
      createElement(ProseImageHeader, {
        storyId: 's1',
        fragment: makeFragment({ meta: { headerAspect: '16:9' } }),
        header,
      }),
    )
    expect(html).toMatch(/aria-pressed="true"[^>]*>16:9<\/button>/)
  })

  it('applies the focal crop position for a bounded image', () => {
    const html = render(
      createElement(ProseImageHeader, {
        storyId: 's1',
        fragment: makeFragment(),
        header: { ...header, boundary: { x: 0.2, y: 0.4, width: 0.4, height: 0.2 } },
      }),
    )
    expect(html).toContain('object-position:40% 50%')
  })
})
