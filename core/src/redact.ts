/**
 * Secret redaction. Every known secret value is registered here before it can
 * appear in a log line; `redact` masks each occurrence with `***`.
 */
export interface Redactor {
  register(value: string | undefined | null): void;
  redact(text: string): string;
  readonly secrets: string[];
}

const MASK = '***';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRedactor(): Redactor {
  const registered = new Set<string>();
  let pattern: RegExp | undefined;

  return {
    register(value) {
      if (!value) return;
      if (registered.has(value)) return;
      registered.add(value);
      // A new secret invalidates the compiled matcher.
      pattern = undefined;
    },

    redact(text) {
      if (registered.size === 0) return text;
      if (!pattern) {
        // Longest first, so a shorter secret that overlaps a longer one cannot
        // mask only part of it and leave the remainder visible.
        const alternatives = [...registered]
          .sort((a, b) => b.length - a.length)
          .map(escapeRegExp);
        pattern = new RegExp(alternatives.join('|'), 'g');
      }
      return text.replace(pattern, MASK);
    },

    get secrets() {
      return [...registered];
    },
  };
}
