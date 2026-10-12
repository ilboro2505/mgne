import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairDifferences } from '../web/src/charts.ts';

const spike = (time, id, ordinal) => ({ time, spikes: [id], recovered: [], ordinals: { [id]: ordinal } });
const truncated = [spike(100, 'a', 8), spike(102, 'b', 7), spike(106, 'a', 9), spike(110, 'b', 8), spike(113, 'a', 10), spike(117, 'b', 9)];

test('spike pairing preserves absolute ordinals when each train was truncated differently', () => {
  assert.deepEqual(pairDifferences(truncated, { source: 'a', target: 'b', sourceOffset: 0, targetOffset: 0 }),
    [{ index: 8, value: 10 }, { index: 9, value: 11 }]);
});

test('independent i/i+1 offsets pair the specified cycles and skip missing partners', () => {
  assert.deepEqual(pairDifferences(truncated, { source: 'a', target: 'b', sourceOffset: 1, targetOffset: 0 }),
    [{ index: 7, value: 2 }, { index: 8, value: 4 }, { index: 9, value: 4 }]);
  assert.deepEqual(pairDifferences(truncated, { source: 'a', target: 'b', sourceOffset: 0, targetOffset: 1 }),
    [{ index: 8, value: 17 }]);
});

test('comparing a neuron with its next spike yields its interspike intervals', () => {
  assert.deepEqual(pairDifferences(truncated, { source: 'a', target: 'a', sourceOffset: 0, targetOffset: 1 }),
    [{ index: 8, value: 6 }, { index: 9, value: 7 }]);
});
