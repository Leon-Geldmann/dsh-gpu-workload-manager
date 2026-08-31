import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/catalog.js';

describe('parseCatalog', () => {
  it('accepts exactly the four configured model ids', () => {
    const catalog = parseCatalog([
      { id: 'qwen3.8-27b', path: '/models/base.gguf', contextSize: 65_536, mtp: 2 },
      { id: 'qwen3.8-27b-uncensored', path: '/models/uncensored.gguf', contextSize: 65_536, mtp: 2 },
      { id: 'qwen3.8-27b-q4', path: '/models/base-q4.gguf', contextSize: 131_072, mtp: 5 },
      { id: 'qwen3.8-27b-uncensored-q4', path: '/models/uncensored-q4.gguf', contextSize: 131_072, mtp: 2 }
    ]);

    expect(catalog.map((model) => model.id)).toEqual([
      'qwen3.8-27b',
      'qwen3.8-27b-uncensored',
      'qwen3.8-27b-q4',
      'qwen3.8-27b-uncensored-q4'
    ]);
  });

  it('rejects a duplicate model id', () => {
    expect(() => parseCatalog([
      { id: 'qwen3.8-27b', path: '/models/a.gguf', contextSize: 65_536, mtp: 2 },
      { id: 'qwen3.8-27b', path: '/models/b.gguf', contextSize: 65_536, mtp: 2 }
    ])).toThrow(/duplicate_model_id/);
  });
});
