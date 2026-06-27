import { packPageUrl } from '@/lib/erratanet/pack-schema'
import { cn } from '@/lib/utils'
import { ExternalLink } from 'lucide-react'

/**
 * A pack id rendered as a hotlink to its page on the hub, falling back to plain
 * mono text when no hub is configured (so the id is still shown). Shared by the
 * ErrataNet panel's published-pack and shared-config rows so both read identically.
 */
export function PackLink({
  pack,
  hubUrl,
  className,
}: {
  pack: string
  hubUrl: string | undefined
  className?: string
}) {
  const url = packPageUrl(hubUrl, pack)
  if (!url) {
    return <p className={cn('truncate font-mono text-foreground', className)}>{pack}</p>
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'group inline-flex max-w-full items-center gap-1 font-mono text-foreground underline-offset-2 hover:underline',
        className,
      )}
    >
      <span className="truncate">{pack}</span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
    </a>
  )
}
