import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { REGISTRY } from '../../src/world/blocks/index';
import { acceptStateIds, readStateLock, STATE_LOCK_PATH, stateLockViolations } from '../harness/stateLock';

// SP3a spec §2.3. `npm run test:accept-state-ids` (ACCEPT_STATE_IDS=1) appends the states of new types and refuses
// changed ids, removed entries and new states of locked types; a commit that changes the lock says so in its message.
test('test/stateIds.lock.json holds every state of the registry with its id (append-only)', () => {
  const lock = readStateLock();
  if (process.env.ACCEPT_STATE_IDS === '1') {
    const r = acceptStateIds(lock, REGISTRY);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) {
      writeFileSync(STATE_LOCK_PATH, `${JSON.stringify(r.next, null, 2)}\n`);
      console.log(r.appended.length > 0 ? `appended ${r.appended.length} state(s): ${r.appended.join(', ')}` : 'no new states; lock unchanged');
    }
    return;
  }
  expect(stateLockViolations(lock, REGISTRY)).toEqual([]);
});
