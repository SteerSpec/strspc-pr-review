// SPDX-License-Identifier: Apache-2.0
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sum, mean } = require('./stats');

test('sum adds the values', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
});

test('mean divides the sum by the count', () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.throws(() => mean([]), RangeError);
});
