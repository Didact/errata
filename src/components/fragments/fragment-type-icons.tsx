import {
  BookMarked,
  BookOpen,
  Boxes,
  Database,
  FileText,
  Hash,
  Image,
  Landmark,
  MapPin,
  NotebookText,
  ScrollText,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react'

export const FRAGMENT_TYPE_ICON_OPTIONS = [
  { value: 'Hash', label: 'Hash' },
  { value: 'FileText', label: 'Document' },
  { value: 'BookOpen', label: 'Book' },
  { value: 'BookMarked', label: 'Marked book' },
  { value: 'NotebookText', label: 'Notebook' },
  { value: 'ScrollText', label: 'Scroll' },
  { value: 'Database', label: 'Database' },
  { value: 'Users', label: 'People' },
  { value: 'MapPin', label: 'Map pin' },
  { value: 'Landmark', label: 'Landmark' },
  { value: 'Boxes', label: 'Boxes' },
  { value: 'Image', label: 'Image' },
  { value: 'Sparkles', label: 'Sparkles' },
] as const

const ICONS: Record<string, LucideIcon> = {
  Hash,
  FileText,
  BookOpen,
  BookMarked,
  NotebookText,
  ScrollText,
  Database,
  Users,
  MapPin,
  Landmark,
  Boxes,
  Image,
  Sparkles,
}

export function getFragmentTypeIconLabel(icon?: string) {
  return FRAGMENT_TYPE_ICON_OPTIONS.find((option) => option.value === icon)?.label ?? 'Hash'
}

export function FragmentTypeIcon({ icon, className }: { icon?: string; className?: string }) {
  const Icon = icon ? ICONS[icon] ?? Hash : Hash
  return <Icon className={className} />
}
