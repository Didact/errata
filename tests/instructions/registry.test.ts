import { describe, it, expect, beforeEach } from 'vitest'
import { instructionRegistry } from '../../src/server/instructions/registry'

describe('InstructionRegistry', () => {
  beforeEach(() => {
    instructionRegistry.clear()
  })

  describe('registerDefault + resolve', () => {
    it('returns default text for a registered key', () => {
      instructionRegistry.registerDefault('test.key', 'Hello world')
      expect(instructionRegistry.resolve('test.key')).toBe('Hello world')
    })

    it('throws for an unregistered key', () => {
      expect(() => instructionRegistry.resolve('nonexistent')).toThrow(
        'Instruction key "nonexistent" not registered',
      )
    })

    it('resolve with no modelId returns default', () => {
      instructionRegistry.registerDefault('test.key', 'default text')
      expect(instructionRegistry.resolve('test.key')).toBe('default text')
      expect(instructionRegistry.resolve('test.key', undefined)).toBe('default text')
    })

    it('resolve with unmatched modelId returns default', () => {
      instructionRegistry.registerDefault('test.key', 'default text')
      expect(instructionRegistry.resolve('test.key', 'some-model')).toBe('default text')
    })
  })

  describe('getDefault', () => {
    it('returns the default text', () => {
      instructionRegistry.registerDefault('test.key', 'text')
      expect(instructionRegistry.getDefault('test.key')).toBe('text')
    })

    it('returns undefined for unregistered key', () => {
      expect(instructionRegistry.getDefault('nonexistent')).toBeUndefined()
    })
  })

  describe('listKeys', () => {
    it('returns all registered keys', () => {
      instructionRegistry.registerDefault('a', 'text-a')
      instructionRegistry.registerDefault('b', 'text-b')
      expect(instructionRegistry.listKeys()).toEqual(expect.arrayContaining(['a', 'b']))
      expect(instructionRegistry.listKeys()).toHaveLength(2)
    })
  })

  describe('clear', () => {
    it('resets all state', async () => {
      instructionRegistry.registerDefault('test.key', 'text')
      expect(instructionRegistry.listKeys()).toHaveLength(1)
      instructionRegistry.clear()
      expect(instructionRegistry.listKeys()).toHaveLength(0)
      expect(instructionRegistry.getDefault('test.key')).toBeUndefined()
    })
  })
})
