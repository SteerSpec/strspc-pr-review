// SPDX-License-Identifier: Apache-2.0
//
// Baseline library of the real-Copilot testbed. Scenario fixtures change it on a
// branch, so Copilot reviews a diff against real code. Keep it small and correct:
// a finding on the baseline itself would show up in every scenario.

'use strict';

function sum(values) {
  return values.reduce((total, v) => total + v, 0);
}

function mean(values) {
  if (values.length === 0) throw new RangeError('mean of an empty list');
  return sum(values) / values.length;
}

module.exports = { sum, mean };
