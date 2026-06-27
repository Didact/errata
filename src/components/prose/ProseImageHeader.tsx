import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Fragment } from '@/lib/api'
import {
  HEADER_ASPECT_RATIOS,
  HEADER_FADE_MASK,
  parseHeaderAspect,
  parseHeaderFade,
  headerFocalPosition,
  type HeaderAspectId,
  type HeaderImage,
} from '@/lib/fragment-visuals'

interface ProseImageHeaderProps {
  storyId: string
  fragment: Fragment
  header: HeaderImage
}

/**
 * Framed image "plate" shown at the top of a prose passage when it links an
 * image visual ref. The aspect ratio is chosen per-prose via a quiet control
 * that fades in on hover/focus (and stays visible on touch). The choice is
 * persisted to the fragment's `meta.headerAspect`.
 */
export function ProseImageHeader({ storyId, fragment, header }: ProseImageHeaderProps) {
  const queryClient = useQueryClient()
  const storedAspect = parseHeaderAspect(fragment.meta)
  const storedFade = parseHeaderFade(fragment.meta)
  const [aspect, setAspect] = useState<HeaderAspectId>(storedAspect)
  const [fade, setFade] = useState(storedFade)

  // Keep local state in step with the persisted values (e.g. edits elsewhere).
  // Keyed on the parsed primitives so meta-object identity churn from unrelated
  // refetches doesn't clobber an in-flight optimistic choice.
  useEffect(() => {
    setAspect(storedAspect)
  }, [storedAspect])
  useEffect(() => {
    setFade(storedFade)
  }, [storedFade])

  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.fragments.update(storyId, fragment.id, {
        name: fragment.name,
        description: fragment.description,
        content: fragment.content,
        sticky: fragment.sticky,
        order: fragment.order,
        placement: fragment.placement,
        meta: { ...fragment.meta, ...patch },
      }),
    // Re-sync from the server whether the save lands or fails, so a failed
    // write rolls the optimistic choice back to the persisted value.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['fragments', storyId] })
    },
  })

  const option = HEADER_ASPECT_RATIOS.find((o) => o.id === aspect) ?? HEADER_ASPECT_RATIOS[0]
  const focal = headerFocalPosition(header.boundary)
  const maskStyle = fade
    ? { maskImage: HEADER_FADE_MASK, WebkitMaskImage: HEADER_FADE_MASK }
    : undefined

  const chooseAspect = (next: HeaderAspectId) => {
    if (next === aspect) return
    setAspect(next) // optimistic — the plate reshapes immediately
    mutation.mutate({ headerAspect: next })
  }

  const toggleFade = () => {
    const next = !fade
    setFade(next)
    mutation.mutate({ headerFade: next })
  }

  return (
    <figure
      className={
        fade
          ? 'group/header relative mb-4 mt-0.5'
          : 'group/header relative mb-4 mt-0.5 overflow-hidden rounded-lg border border-border/40 bg-muted/20 shadow-sm shadow-black/[0.04]'
      }
    >
      {option.ratio === null ? (
        <img
          src={header.imageUrl}
          alt={header.name}
          loading="lazy"
          className="block w-full h-auto"
          style={maskStyle}
        />
      ) : (
        <img
          src={header.imageUrl}
          alt={header.name}
          loading="lazy"
          className="block w-full object-cover"
          style={{ aspectRatio: String(option.ratio), objectPosition: focal, ...maskStyle }}
        />
      )}

      {/* Display controls — quiet by default, revealed on hover/focus/touch. */}
      <div
        role="group"
        aria-label="Header image display"
        className="absolute right-2 top-2 flex items-center gap-0.5 rounded-lg border border-border/40 bg-background/70 p-0.5 shadow-sm backdrop-blur-md opacity-0 transition-opacity duration-200 group-hover/header:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
      >
        {HEADER_ASPECT_RATIOS.map((o) => {
          const selected = o.id === aspect
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={selected}
              title={o.title}
              disabled={mutation.isPending}
              onClick={(e) => {
                e.stopPropagation()
                chooseAspect(o.id)
              }}
              className={`rounded-md px-1.5 py-0.5 font-mono text-[0.625rem] leading-none transition-colors disabled:opacity-50 ${
                selected
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}
            >
              {o.label}
            </button>
          )
        })}

        <span aria-hidden className="mx-0.5 h-3 w-px bg-border/50" />

        <button
          type="button"
          aria-pressed={fade}
          title="Fade top &amp; bottom edges"
          disabled={mutation.isPending}
          onClick={(e) => {
            e.stopPropagation()
            toggleFade()
          }}
          className={`rounded-md px-1.5 py-0.5 font-mono text-[0.625rem] leading-none transition-colors disabled:opacity-50 ${
            fade
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          }`}
        >
          Fade
        </button>
      </div>
    </figure>
  )
}
