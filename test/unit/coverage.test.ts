import { expect, test } from 'vitest';
import { NO_COVERAGE, reconcile, reduce, runCommands, status, type CoverageEvent } from '../../src/coverage.js';
import { fakeAdapters } from './fakes.js';

function fold(events: readonly CoverageEvent[]) {
  return events.reduce(reduce, NO_COVERAGE);
}

test('a re-derive that fails is recorded and asked for again on the next tick', async () => {
  const adapters = fakeAdapters();
  adapters.storage.fail('Storage is unavailable');

  const [event] = await runCommands([{ type: 'rederive' }], adapters);
  const failed = reduce(fold([{ type: 'tick', now: 1000 }]), event!);

  expect(status(failed).error).toBe('Storage is unavailable');
  expect(reconcile(failed)).toEqual([]);
  expect(reconcile(reduce(failed, { type: 'tick', now: 2000 }))).toEqual([{ type: 'rederive' }]);
});

test('a tab Chrome says another debugger is already attached to is Covered', async () => {
  const adapters = fakeAdapters();
  adapters.debuggerAdapter.failAttach(7, 'Another debugger is already attached to the tab with id: 7.');

  const events = await runCommands([{ type: 'cover', tabId: 7, zone: 'Asia/Tokyo' }], adapters);

  expect(events).toEqual([{ type: 'covered', tabId: 7 }]);
  expect(adapters.debuggerAdapter.zoneOf(7)).toBe('Asia/Tokyo');
});
