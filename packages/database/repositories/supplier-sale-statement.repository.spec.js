'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateStatementTotals } = require('./supplier-sale-statement.repository');

test('floor-rupee commission matches the DDEC Pattiyal example', () => {
  const totals = calculateStatementTotals({
    allocations: [
      { merchandiseAmount: 177672 },
      { merchandiseAmount: 115379 },
      { merchandiseAmount: 47040 }
    ],
    commissionRate: 3,
    commissionRounding: 'floor_rupee',
    adjustments: []
  });

  assert.equal(totals.merchandiseSubtotal, 340091);
  assert.equal(totals.commissionAmount, 10202);
  assert.equal(totals.netPayable, 329889);
});

test('credits and deductions remain explicit around the commission result', () => {
  const totals = calculateStatementTotals({
    manualLines: [{ merchandiseAmount: 1000 }],
    commissionRate: 3,
    commissionRounding: 'cents',
    adjustments: [
      { adjustmentType: 'deduction', amount: 25 },
      { adjustmentType: 'credit', amount: 10 }
    ]
  });

  assert.equal(totals.commissionAmount, 30);
  assert.equal(totals.adjustmentTotal, -15);
  assert.equal(totals.netPayable, 955);
});

test('zero-value sale lines remain valid in totals', () => {
  const totals = calculateStatementTotals({
    allocations: [{ merchandiseAmount: 0 }],
    commissionRate: 3,
    commissionRounding: 'cents'
  });

  assert.deepEqual(totals, {
    merchandiseSubtotal: 0,
    commissionAmount: 0,
    adjustmentTotal: 0,
    netPayable: 0
  });
});
