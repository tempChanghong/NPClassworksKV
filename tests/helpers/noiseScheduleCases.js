import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Shared fixture expectations are static; this harness never calculates its own expected result.
export function registerScheduleCases(api, fixtureUrl) {
  const cases = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  for (const [section, values] of Object.entries(cases)) {
    for (const item of values) {
      test(`${section}: ${item.name}`, () => {
        let actual;
        switch (section) {
          case 'validation': actual = api.validatePolicy(item.policy, item.grade); break;
          case 'resolution': actual = api.resolvePolicy(item.grade, item.classroom); break;
          case 'windows': actual = api.windows(item.policy, item.now); break;
          case 'decisions': actual = api.evaluate(item.input); break;
          case 'leases': actual = api.leaseValid(item.lease, item.current); break;
          default: assert.fail(`Unknown fixture group: ${section}`);
        }
        assert.deepEqual(actual, item.expected);
      });
    }
  }
  test('invalid school calendars and extra policy fields rejected', () => {
    const policy = {source: 'Grade', rules: [{days: [1], start: '19:00', end: '21:00'}]};
    for (const now of ['2026-09-28T19:00:00Z', '2026-09-28T19:00:00+08:00', '1999-01-01T00:00:00', '2026-02-30T00:00:00', '2026-09-28T24:00:00']) {
      assert.throws(() => api.windows(policy, now), /INVALID_SCHOOL_CALENDAR/);
    }
    assert.notEqual(api.validatePolicy({mode: 'Disabled', rules: [], startMicrophone: true}), null);
    assert.notEqual(api.validatePolicy({mode: 'Override', rules: [{...policy.rules[0], extra: true}]}), null);
    assert.notEqual(api.validatePolicy({mode: 'Override', rules: [{...policy.rules[0], days: [1.5]}]}), null);
  });
  test('nonfinite lease values and malformed identity cannot renew', () => {
    const hostId = '11111111-1111-4111-8111-111111111111';
    const lease = {hostId, scope: 'scope', revision: 1, confirmedAtMs: 0, lifetimeMs: 100};
    const current = {hostId, scope: 'scope', revision: 1, elapsedMs: 1};
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal(api.leaseValid(lease, {...current, elapsedMs: value}), false);
      assert.equal(api.leaseValid({...lease, confirmedAtMs: value}, current), false);
      assert.equal(api.leaseValid({...lease, lifetimeMs: value}, current), false);
    }
    assert.equal(api.leaseValid({...lease, hostId: 'not-a-guid'}, {...current, hostId: 'not-a-guid'}), false);
  });
}
