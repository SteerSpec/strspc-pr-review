// SPDX-License-Identifier: Apache-2.0
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { median } = require('./median');

test('median of an odd count is the middle value', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('median of an even count is the mean of the middle two', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('median of nothing throws', () => {
  assert.throws(() => median([]), RangeError);
});
