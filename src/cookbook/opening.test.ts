import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openCookbook } from '../host-client/cookbook-storage';
import type { CookbookConnection, CookbookStatus, LocalCopyState } from '../host-client/cookbook-storage';
import { openCookbookAttempt } from './opening';
vi.mock('../host-client/cookbook-storage', () => ({ openCookbook: vi.fn() }));

const options = { id: 'test', relayUrl: 'ws://relay' };
let copy: LocalCopyState;
let status: CookbookStatus;
let synced: boolean;
let copies: Set<() => void>;
let statuses: Set<() => void>;
let connection: CookbookConnection;
let abort: AbortController;
beforeEach(() => {
  vi.useFakeTimers();
  abort = new AbortController();
  copy = 'pending'; status = 'connecting'; synced = false;
  copies = new Set(); statuses = new Set();
  connection = {
    localCopy: () => copy, remoteSynced: () => synced, status: () => status,
    onLocalCopy: (listener: () => void) => { copies.add(listener); return () => copies.delete(listener); },
    onStatus: (listener: () => void) => { statuses.add(listener); return () => statuses.delete(listener); },
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as CookbookConnection;
  vi.mocked(openCookbook).mockResolvedValue(connection);
});
afterEach(() => { abort.abort(); vi.useRealTimers(); vi.clearAllMocks(); });
const emitCopy = () => copies.forEach((listener) => listener());
const emitStatus = () => statuses.forEach((listener) => listener());

it.each(['disconnect', 'deadline'])('opens after %s without ending recovery or mounting twice', async (interruption) => {
  const warn = vi.fn(); const mount = vi.fn();
  const opened = openCookbookAttempt(options, abort.signal, warn).then(mount);
  await Promise.resolve();
  if (interruption === 'disconnect') { status = 'offline'; emitStatus(); }
  else await vi.advanceTimersByTimeAsync(5_000);
  expect(warn).toHaveBeenCalledWith('connection');
  expect(mount).not.toHaveBeenCalled();
  synced = true; copy = 'ready'; emitCopy();
  await opened;
  expect(mount).toHaveBeenCalledExactlyOnceWith(connection);
  emitCopy(); status = 'offline'; emitStatus();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mount).toHaveBeenCalledTimes(1);
  expect(copies.size + statuses.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('reports storage failure after a connection warning without false readiness', async () => {
  const warn = vi.fn();
  const opened = openCookbookAttempt(options, abort.signal, warn);
  const rejected = expect(opened).rejects.toThrow('disk full');
  await Promise.resolve();
  status = 'offline'; emitStatus();
  copy = new Error('disk full'); emitCopy();
  await rejected;
  expect(warn).toHaveBeenCalledWith('connection');
  expect(connection.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels listeners and ignores an obsolete readiness callback', async () => {
  const warn = vi.fn();
  const opened = openCookbookAttempt(options, abort.signal, warn);
  await Promise.resolve();
  const obsolete = [...copies][0];
  abort.abort(); copy = 'ready'; obsolete();
  await expect(opened).resolves.toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(warn).not.toHaveBeenCalled();
  expect(connection.close).toHaveBeenCalledOnce();
  expect(copies.size + statuses.size).toBe(0);
});

it('owns the deadline and cancellation before local initialization finishes', async () => {
  let finish!: (value: CookbookConnection) => void;
  vi.mocked(openCookbook).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const warn = vi.fn();
  const opened = openCookbookAttempt(options, abort.signal, warn);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(warn).toHaveBeenCalledExactlyOnceWith('storage');
  abort.abort();
  await expect(opened).resolves.toBeNull();
  finish(connection); await Promise.resolve();
  expect(connection.close).toHaveBeenCalledOnce();
  expect(copies.size + statuses.size).toBe(0);
});

it('opens an already-ready empty local copy without waiting for the relay', async () => {
  copy = 'ready'; status = 'offline';
  const warn = vi.fn();
  await expect(openCookbookAttempt(options, abort.signal, warn)).resolves.toBe(connection);
  expect(warn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not call a stalled first-copy commit an internet failure', async () => {
  synced = true;
  const warn = vi.fn();
  const opened = openCookbookAttempt(options, abort.signal, warn);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(warn).toHaveBeenCalledExactlyOnceWith('storage');
  copy = 'ready'; emitCopy();
  await expect(opened).resolves.toBe(connection);
});
