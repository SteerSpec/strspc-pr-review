// SPDX-License-Identifier: Apache-2.0
'use strict';

// The middle value of a list, or the mean of the two middle values.
function median(values) {
  if (values.length === 0) throw new RangeError('median of an empty list');
  const sorted = values.sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

module.exports = { median };
