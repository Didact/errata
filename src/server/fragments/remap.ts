import type { Fragment, Associations } from './schema'

/**
 * ID remapping helpers shared by the story-archive importer and any other
 * consumer that needs to rewrite fragment ids consistently across a bundle.
 *
 * All functions are pure: they take an `idMap` of old id -> new id and return
 * new values without mutating their inputs. Ids missing from the map are left
 * unchanged.
 */
export type IdMap = Map<string, string> | Record<string, string>

function lookup(idMap: IdMap, id: string): string | undefined {
  return idMap instanceof Map ? idMap.get(id) : idMap[id]
}

function has(idMap: IdMap, id: string): boolean {
  return idMap instanceof Map ? idMap.has(id) : Object.prototype.hasOwnProperty.call(idMap, id)
}

/**
 * Remap the id-bearing fields inside a fragment's `meta` blob:
 * `visualRefs[].fragmentId`, `previousFragmentId`, and `variationOf`.
 * Returns a new object; the input is not mutated.
 */
export function remapMeta(
  meta: Record<string, unknown>,
  idMap: IdMap,
): Record<string, unknown> {
  const result = { ...meta }

  // Remap visualRefs[].fragmentId
  if (Array.isArray(result.visualRefs)) {
    result.visualRefs = (result.visualRefs as Array<Record<string, unknown>>).map((ref) => ({
      ...ref,
      fragmentId: lookup(idMap, ref.fragmentId as string) ?? ref.fragmentId,
    }))
  }

  // Remap previousFragmentId
  if (typeof result.previousFragmentId === 'string' && has(idMap, result.previousFragmentId)) {
    result.previousFragmentId = lookup(idMap, result.previousFragmentId)
  }

  // Remap variationOf
  if (typeof result.variationOf === 'string' && has(idMap, result.variationOf)) {
    result.variationOf = lookup(idMap, result.variationOf)
  }

  return result
}

/**
 * Remap a single fragment's id-bearing fields: its own `id`, `refs[]`, and the
 * id references inside `meta` (via {@link remapMeta}). Returns a new fragment;
 * the input is not mutated. Ids missing from the map are left unchanged.
 */
export function remapFragment(fragment: Fragment, idMap: IdMap): Fragment {
  return {
    ...fragment,
    id: lookup(idMap, fragment.id) ?? fragment.id,
    refs: fragment.refs.map((ref) => lookup(idMap, ref) ?? ref),
    meta: remapMeta(fragment.meta, idMap),
  }
}

/**
 * Remap the fragment ids inside an associations index: every id in `tagIndex`
 * and `refIndex` values, the `refIndex` keys themselves, and the embedded id in
 * `__backref:<id>` keys. Returns a new object; the input is not mutated.
 */
export function remapAssociations(assoc: Associations, idMap: IdMap): Associations {
  const newTagIndex: Record<string, string[]> = {}
  for (const [tag, ids] of Object.entries(assoc.tagIndex)) {
    newTagIndex[tag] = ids.map((id) => lookup(idMap, id) ?? id)
  }

  const newRefIndex: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(assoc.refIndex)) {
    let newKey = key
    // Remap __backref: keys
    if (key.startsWith('__backref:')) {
      const oldId = key.slice('__backref:'.length)
      const newId = lookup(idMap, oldId) ?? oldId
      newKey = `__backref:${newId}`
    } else if (has(idMap, key)) {
      newKey = lookup(idMap, key)!
    }
    newRefIndex[newKey] = ids.map((id) => lookup(idMap, id) ?? id)
  }

  return { tagIndex: newTagIndex, refIndex: newRefIndex }
}
