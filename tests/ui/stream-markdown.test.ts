import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StreamMarkdown } from '@/components/ui/stream-markdown'

describe('StreamMarkdown', () => {
  it('renders GitHub-flavored markdown tables', () => {
    const html = renderToStaticMarkup(createElement(StreamMarkdown, {
      content: [
        '| Character | Status |',
        '| --- | --- |',
        '| Mira | Missing |',
      ].join('\n'),
    }))

    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('Character')
    expect(html).toContain('<td')
    expect(html).toContain('Missing')
  })
})
