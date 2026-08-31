import type { ModelSpec } from './types.js';

const MODEL_KEYS = new Set(['id', 'path', 'contextSize', 'mtp']);

export function parseCatalog(value: unknown): readonly ModelSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('invalid_catalog');
  }

  const seenIds = new Set<string>();
  return Object.freeze(value.map((candidate) => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, MODEL_KEYS)) {
      throw new Error('invalid_model_spec');
    }

    const { id, path, contextSize, mtp } = candidate;
    if (!isNonEmptyString(id) || !isNonEmptyString(path) || typeof contextSize !== 'number' || !Number.isSafeInteger(contextSize) || contextSize <= 0 || typeof mtp !== 'number' || !Number.isSafeInteger(mtp) || mtp < 0) {
      throw new Error('invalid_model_spec');
    }
    if (seenIds.has(id)) {
      throw new Error('duplicate_model_id');
    }
    seenIds.add(id);
    const spec: ModelSpec = { id, path, contextSize, mtp };
    return Object.freeze(spec);
  }));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key)) && [...allowed].every((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
