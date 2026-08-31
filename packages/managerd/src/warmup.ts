export async function warmChild(endpoint: string, inferenceKey: string, model: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${inferenceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, max_tokens: 1, messages: [{ role: 'system', content: 'Warm up.' }, { role: 'user', content: 'x' }], cache_prompt: true }),
    signal,
  });
  if (!response.ok) throw new Error('warmup_failed');
  if (!hasGeneratedToken(await response.json())) throw new Error('warmup_missing_token');
}

function hasGeneratedToken(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.usage) || typeof value.usage.completion_tokens !== 'number' || value.usage.completion_tokens < 1 || !Array.isArray(value.choices)) return false;
  return value.choices.some((choice) => isRecord(choice) && (typeof choice.text === 'string' && choice.text.length > 0 || isRecord(choice.message) && typeof choice.message.content === 'string' && choice.message.content.length > 0 || isRecord(choice.delta) && typeof choice.delta.content === 'string' && choice.delta.content.length > 0));
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
