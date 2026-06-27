import type { Fragment } from '@/lib/api'

export interface BoundaryBox {
  x: number
  y: number
  width: number
  height: number
}

export interface VisualRef {
  fragmentId: string
  kind: 'image' | 'icon'
  boundary?: BoundaryBox
}

interface ImagePayload {
  url?: string
}

export function parseVisualRefs(meta: Record<string, unknown> | undefined): VisualRef[] {
  const raw = meta?.visualRefs
  if (!Array.isArray(raw)) return []

  const refs: VisualRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const fragmentId = typeof obj.fragmentId === 'string' ? obj.fragmentId : null
    const kind = obj.kind === 'icon' ? 'icon' : obj.kind === 'image' ? 'image' : null
    if (!fragmentId || !kind) continue

    let boundary: BoundaryBox | undefined
    const rawBoundary = obj.boundary
    if (rawBoundary && typeof rawBoundary === 'object') {
      const b = rawBoundary as Record<string, unknown>
      const x = typeof b.x === 'number' ? b.x : 0
      const y = typeof b.y === 'number' ? b.y : 0
      const width = typeof b.width === 'number' ? b.width : 1
      const height = typeof b.height === 'number' ? b.height : 1
      if (width > 0 && height > 0) {
        boundary = { x, y, width, height }
      }
    }

    refs.push({ fragmentId, kind, boundary })
  }

  return refs
}

export function readImageUrl(fragment: Fragment): string | null {
  const raw = fragment.content.trim()
  if (!raw) return null

  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:image/')) {
    return raw
  }

  try {
    const parsed = JSON.parse(raw) as ImagePayload
    if (typeof parsed.url === 'string' && parsed.url.trim()) {
      return parsed.url.trim()
    }
  } catch {
    // Non-JSON content; no URL to extract.
  }

  return null
}

export function gradientForId(id: string): string {
  const gradients = [
    'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
    'linear-gradient(135deg, #22c55e 0%, #14b8a6 100%)',
    'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)',
    'linear-gradient(135deg, #eab308 0%, #f97316 100%)',
    'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)',
    'linear-gradient(135deg, #f43f5e 0%, #fb7185 100%)',
  ]

  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i)
    hash |= 0
  }
  const index = Math.abs(hash) % gradients.length
  return gradients[index]
}

// ── Bubble system ─────────────────────────────────────

// Seeded PRNG (mulberry32)
function seededRng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i)
    h |= 0
  }
  return h
}

export type BubbleShape = 'circle' | 'rounded-rect' | 'hexagon' | 'ellipse' | 'diamond'

export interface Bubble {
  cx: number
  cy: number
  r: number
  color: string
  opacity: number
  shape: BubbleShape
  rotation: number
}

export interface BubbleSet {
  bg: string
  bubbles: Bubble[]
}

const TYPE_PALETTES: Record<string, { bg: string; colors: string[]; shape: BubbleShape }> = {
  character: {
    bg: 'oklch(0.42 0.06 15)',
    colors: ['oklch(0.68 0.17 10)', 'oklch(0.74 0.14 35)', 'oklch(0.63 0.15 350)', 'oklch(0.70 0.12 25)', 'oklch(0.78 0.10 50)'],
    shape: 'circle',
  },
  guideline: {
    bg: 'oklch(0.40 0.06 250)',
    colors: ['oklch(0.66 0.15 250)', 'oklch(0.72 0.12 220)', 'oklch(0.60 0.17 270)', 'oklch(0.76 0.10 200)', 'oklch(0.68 0.13 240)'],
    shape: 'rounded-rect',
  },
  knowledge: {
    bg: 'oklch(0.40 0.06 160)',
    colors: ['oklch(0.66 0.14 160)', 'oklch(0.72 0.12 140)', 'oklch(0.60 0.15 175)', 'oklch(0.76 0.10 150)', 'oklch(0.68 0.13 130)'],
    shape: 'hexagon',
  },
  prose: {
    bg: 'oklch(0.44 0.04 60)',
    colors: ['oklch(0.70 0.10 60)', 'oklch(0.65 0.08 45)', 'oklch(0.75 0.07 75)', 'oklch(0.62 0.11 50)', 'oklch(0.78 0.06 70)'],
    shape: 'ellipse',
  },
  image: {
    bg: 'oklch(0.40 0.06 300)',
    colors: ['oklch(0.66 0.15 300)', 'oklch(0.72 0.12 280)', 'oklch(0.60 0.14 320)', 'oklch(0.76 0.10 290)', 'oklch(0.68 0.15 310)'],
    shape: 'diamond',
  },
  marker: {
    bg: 'oklch(0.42 0.08 85)',
    colors: ['oklch(0.72 0.14 85)', 'oklch(0.78 0.12 70)', 'oklch(0.66 0.16 95)', 'oklch(0.80 0.10 75)', 'oklch(0.74 0.13 60)'],
    shape: 'diamond',
  },
  // Summaries: quiet, parchment-bookmark palette — warm ochre reading like
  // annotated page edges. Librarian-managed; rarely decorated beyond context.
  summary: {
    bg: 'oklch(0.40 0.05 65)',
    colors: ['oklch(0.70 0.09 70)', 'oklch(0.74 0.08 55)', 'oklch(0.66 0.10 80)', 'oklch(0.72 0.07 50)', 'oklch(0.68 0.09 65)'],
    shape: 'rounded-rect',
  },
}

export function generateBubbles(id: string, type: string): BubbleSet {
  const palette = TYPE_PALETTES[type] ?? TYPE_PALETTES.prose
  const rng = seededRng(hashString(id))
  const count = 4 + Math.floor(rng() * 3) // 4–6 bubbles

  const bubbles: Bubble[] = []
  for (let i = 0; i < count; i++) {
    bubbles.push({
      cx: rng() * 36,
      cy: rng() * 36,
      r: 5 + rng() * 12,
      color: palette.colors[Math.floor(rng() * palette.colors.length)],
      opacity: 0.35 + rng() * 0.45,
      shape: palette.shape,
      rotation: rng() * 360,
    })
  }

  return { bg: palette.bg, bubbles }
}

/** Renders a single bubble shape as an SVG element string-safe for JSX */
function hexagonPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = []
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6
    pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`)
  }
  return pts.join(' ')
}

function diamondPoints(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r * 0.7},${cy} ${cx},${cy + r} ${cx - r * 0.7},${cy}`
}

export { hexagonPoints, diamondPoints }

export const CHARACTER_MENTION_COLORS = TYPE_PALETTES.character.colors

// ── Prose header images ───────────────────────────────
// A prose fragment can carry an image visualRef that renders as a framed
// "plate" at the top of the passage. The frame's shape is chosen per-prose
// and stored in meta.headerAspect.

export type HeaderAspectId = '21:9' | '16:9' | '3:2' | '1:1' | 'original'

export interface HeaderAspectOption {
  id: HeaderAspectId
  /** Short label shown in the ratio control. */
  label: string
  /** Spoken/title label for assistive tech. */
  title: string
  /** width / height; null means the image's natural shape (no crop). */
  ratio: number | null
}

// Cinematic plate first — it reads most like a hardback illustration.
export const HEADER_ASPECT_RATIOS: HeaderAspectOption[] = [
  { id: '21:9', label: '21:9', title: 'Cinematic 21:9', ratio: 21 / 9 },
  { id: '16:9', label: '16:9', title: 'Wide 16:9', ratio: 16 / 9 },
  { id: '3:2', label: '3:2', title: 'Photo 3:2', ratio: 3 / 2 },
  { id: '1:1', label: '1:1', title: 'Square 1:1', ratio: 1 },
  { id: 'original', label: 'Full', title: 'Original shape', ratio: null },
]

export const DEFAULT_HEADER_ASPECT: HeaderAspectId = '21:9'

export function parseHeaderAspect(meta: Record<string, unknown> | undefined): HeaderAspectId {
  const raw = meta?.headerAspect
  if (typeof raw === 'string' && HEADER_ASPECT_RATIOS.some((o) => o.id === raw)) {
    return raw as HeaderAspectId
  }
  return DEFAULT_HEADER_ASPECT
}

export interface HeaderImage {
  imageUrl: string
  name: string
  boundary?: BoundaryBox
}

/**
 * Resolve the header image for a fragment: the first *image*-kind visual ref
 * (icons are avatar-scale and never used as a banner). Returns null unless a
 * linked image fragment with a usable URL exists.
 */
export function resolveHeaderImage(
  fragment: Fragment,
  mediaById: Map<string, Fragment>,
): HeaderImage | null {
  const ref = parseVisualRefs(fragment.meta).find((r) => r.kind === 'image')
  if (!ref) return null
  const media = mediaById.get(ref.fragmentId)
  if (!media) return null
  const imageUrl = readImageUrl(media)
  if (!imageUrl) return null
  return { imageUrl, name: media.name, boundary: ref.boundary }
}

/**
 * `object-position` for a cover-fit header that keeps the crop region's center
 * in view. Falls back to a centered crop when no boundary is set.
 */
export function headerFocalPosition(boundary?: BoundaryBox): string {
  if (!boundary) return '50% 50%'
  const clamp = (n: number) => Math.max(0, Math.min(1, n))
  const fx = clamp(boundary.x + boundary.width / 2)
  const fy = clamp(boundary.y + boundary.height / 2)
  const fmt = (n: number) => `${Number((n * 100).toFixed(2))}%`
  return `${fmt(fx)} ${fmt(fy)}`
}

export function parseHeaderFade(meta: Record<string, unknown> | undefined): boolean {
  return meta?.headerFade === true
}

// Fades a header image's top and bottom edges into transparency so the
// illustration bleeds into the page (parchment, dark, or high-contrast alike)
// instead of sitting inside a hard frame. Applied as a CSS mask on the image.
export const HEADER_FADE_MASK =
  'linear-gradient(to bottom, transparent 0%, #000 12%, #000 88%, transparent 100%)'

export function resolveFragmentVisual(fragment: Fragment, mediaById: Map<string, Fragment>): {
  imageUrl: string | null
  boundary?: BoundaryBox
} {
  if (fragment.type === 'image' || fragment.type === 'icon') {
    return { imageUrl: readImageUrl(fragment) }
  }

  const refs = parseVisualRefs(fragment.meta)
  const selected = refs.find((r) => r.kind === 'icon') ?? refs.find((r) => r.kind === 'image')
  if (!selected) return { imageUrl: null }

  const media = mediaById.get(selected.fragmentId)
  if (!media) return { imageUrl: null }

  return {
    imageUrl: readImageUrl(media),
    boundary: selected.boundary,
  }
}
