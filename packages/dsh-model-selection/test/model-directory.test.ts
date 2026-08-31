import { describe, expect, it, vi } from 'vitest';
import type { SessionId, SessionModels } from '@deepseek-ai/dsh-api-remotes/client';
import { ModelDirectory } from '../src/model-directory.js';

const sessionId = 'session-a' as SessionId;
const catalog = (model: string): SessionModels => ({
  current: { provider: 'deepseek', model },
  routable: true,
  groups: [{ id: 'deepseek', name: 'Online', models: [{ id: model, name: model }] }],
  failures: [],
});

describe('ModelDirectory', () => {
  it('keeps the last good catalog visible when a refresh fails', async () => {
    const sessions = fakeSessions();
    sessions.models
      .mockResolvedValueOnce({ result: ok(catalog('deepseek-chat')) })
      .mockResolvedValueOnce({ result: fail('offline', 'catalog unavailable') });
    const directory = new ModelDirectory(sessions as never, sessionId, () => true);

    await directory.load();
    await expect(directory.load()).rejects.toThrow('session.models failed');
    expect(directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'deepseek', model: 'deepseek-chat' },
      groups: [{ id: 'deepseek' }],
      status: 'error',
      error: 'offline: catalog unavailable',
    });
  });

  it('submits opaque reasoning effort and publishes only the latest selection', async () => {
    const sessions = fakeSessions();
    sessions.selectModel.mockResolvedValue({ result: ok({ selected: {
      provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max',
    } }) });
    const directory = new ModelDirectory(sessions as never, sessionId, () => true);

    await directory.select({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' });
    expect(sessions.selectModel).toHaveBeenCalledWith({
      sessionId,
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'max',
    });
    expect(directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' },
      routable: true,
      status: 'ready',
    });
  });

  it('ignores an older load settlement and fails closed for addressed sessions', async () => {
    const first = deferred<{ result: ReturnType<typeof ok<SessionModels>> }>();
    const second = deferred<{ result: ReturnType<typeof ok<SessionModels>> }>();
    const sessions = fakeSessions();
    sessions.models.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let available = true;
    const directory = new ModelDirectory(sessions as never, sessionId, () => available);

    const older = directory.load();
    const newer = directory.load();
    second.resolve({ result: ok(catalog('newer')) });
    await newer;
    first.resolve({ result: ok(catalog('older')) });
    await older;
    expect(directory.store.getSnapshot().current?.model).toBe('newer');

    available = false;
    await expect(directory.load()).rejects.toThrow('addressed subagent sessions');
    expect(sessions.models).toHaveBeenCalledTimes(2);
  });
});

function fakeSessions() {
  return {
    models: vi.fn(),
    selectModel: vi.fn(),
  };
}

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function fail(code: string, message: string) {
  return { ok: false as const, error: { code, message, details: {} } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
