import { describe, it, expect } from 'vitest'
import {
  ContentKindSchema,
  ErratapackManifestSchema,
  AgentConfigSummarySchema,
  isManifestSafeForMvp,
  manifestRequiresConsent,
  type ErratapackManifest,
} from '@/lib/erratanet/pack-schema'

/** A minimal valid manifest of the given kind, with the supplied capabilities. */
function manifest(
  contentKind: ErratapackManifest['contentKind'],
  capabilities: string[] = [],
  agentConfig?: ErratapackManifest['agentConfig'],
): ErratapackManifest {
  return ErratapackManifestSchema.parse({
    errataPack: 1,
    id: '@tester/thing',
    version: '1.0.0',
    title: 'Thing',
    description: 'A thing.',
    license: 'MIT',
    contentKind,
    errataFormatVersion: 1,
    fragmentTypes: [],
    fragmentCount: 0,
    tags: [],
    capabilities,
    dependencies: [],
    payloadHash: 'sha256:' + '0'.repeat(64),
    createdAt: '2026-06-10T00:00:00.000Z',
    ...(agentConfig ? { agentConfig } : {}),
  })
}

describe('agent-config content kind', () => {
  it('is a valid ContentKind alongside fragment-pack and story', () => {
    expect(ContentKindSchema.parse('agent-config')).toBe('agent-config')
    expect(ContentKindSchema.parse('fragment-pack')).toBe('fragment-pack')
    expect(ContentKindSchema.parse('story')).toBe('story')
    expect(() => ContentKindSchema.parse('nonsense')).toThrow()
  })

  it('carries an optional agentConfig summary on the manifest', () => {
    const m = manifest('agent-config', ['agent-config'], {
      agents: ['generation', 'librarian'],
      blockCount: 4,
      hasScripts: false,
      includes: ['agent-blocks', 'model-roles'],
    })
    expect(m.agentConfig?.agents).toEqual(['generation', 'librarian'])
    expect(m.agentConfig?.blockCount).toBe(4)
    expect(m.agentConfig?.includes).toContain('agent-blocks')
  })

  it('defaults agentConfig summary fields', () => {
    const summary = AgentConfigSummarySchema.parse({})
    expect(summary.agents).toEqual([])
    expect(summary.blockCount).toBe(0)
    expect(summary.hasScripts).toBe(false)
    expect(summary.includes).toEqual([])
  })

  it('rejects an unknown include value', () => {
    expect(() => AgentConfigSummarySchema.parse({ includes: ['nope'] })).toThrow()
  })
})

describe('isManifestSafeForMvp (capability allowlist)', () => {
  it('treats fragment/story packs with no capabilities as safe (unchanged)', () => {
    expect(isManifestSafeForMvp(manifest('fragment-pack'))).toBe(true)
    expect(isManifestSafeForMvp(manifest('story'))).toBe(true)
  })

  it('refuses fragment/story packs that declare any capability', () => {
    expect(isManifestSafeForMvp(manifest('fragment-pack', ['scripts']))).toBe(false)
    expect(isManifestSafeForMvp(manifest('story', ['agent-config']))).toBe(false)
  })

  it('allows agent-config packs that declare only known capabilities', () => {
    expect(isManifestSafeForMvp(manifest('agent-config', ['agent-config']))).toBe(true)
    expect(isManifestSafeForMvp(manifest('agent-config', ['agent-config', 'scripts']))).toBe(true)
  })

  it('refuses agent-config packs that declare an unknown capability', () => {
    expect(isManifestSafeForMvp(manifest('agent-config', ['agent-config', 'rootkit']))).toBe(false)
  })
})

describe('manifestRequiresConsent', () => {
  it('is true only when the pack declares the scripts capability', () => {
    expect(manifestRequiresConsent(manifest('agent-config', ['agent-config']))).toBe(false)
    expect(manifestRequiresConsent(manifest('agent-config', ['agent-config', 'scripts']))).toBe(true)
    expect(manifestRequiresConsent(manifest('fragment-pack'))).toBe(false)
  })
})
