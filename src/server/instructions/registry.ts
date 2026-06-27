/**
 * Registry of the app's built-in instruction strings, keyed by name (e.g.
 * `generation.system`, `librarian.chat.system`). Agents register their defaults
 * at startup and resolve them at request time.
 *
 * Model-specific JSON overrides (`data/instruction-sets/*.json`) were removed:
 * per-agent block configuration supersedes them. `resolve` keeps its optional
 * `modelId` parameter for call-site compatibility, but ignores it.
 */
class InstructionRegistry {
  private defaults = new Map<string, string>()

  registerDefault(key: string, text: string): void {
    this.defaults.set(key, text)
  }

  resolve(key: string, _modelId?: string): string {
    const defaultText = this.defaults.get(key)
    if (defaultText === undefined) {
      throw new Error(`Instruction key "${key}" not registered`)
    }
    return defaultText
  }

  getDefault(key: string): string | undefined {
    return this.defaults.get(key)
  }

  listKeys(): string[] {
    return [...this.defaults.keys()]
  }

  clear(): void {
    this.defaults.clear()
  }
}

export const instructionRegistry = new InstructionRegistry()
