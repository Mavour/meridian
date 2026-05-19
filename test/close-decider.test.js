import assert from "assert";
import { decideCloseAction } from "../tools/close-decider.js";

function reason(position, config = {}) {
  return decideCloseAction(position, {
    outOfRangeWaitMinutes: 25,
    ...config,
  }).reason;
}

function testStopLossBeatsRecovery() {
  assert.equal(reason({ pnlPct: -16, inRange: false, oorMinutes: 30 }), "hard_stop");
  assert.equal(reason({ pnlPct: -12.5, inRange: false, oorMinutes: 30 }), "stop_loss");
}

function testOorRecoveryFlow() {
  assert.equal(reason({ pnlPct: 0.1, inRange: false, oorMinutes: 30 }), "oor_recovery_profit");
  assert.equal(reason({ pnlPct: -4, inRange: false, oorMinutes: 30 }), "oor_hold_recovery");
  assert.equal(reason({ pnlPct: -4, inRange: false, oorMinutes: 60 }), "oor_timeout");
  assert.equal(reason({ pnlPct: -1, inRange: false, oorMinutes: 30 }), "oor_timeout");
}

function testProfitAndTrailingAfterOorRecovery() {
  assert.equal(reason({ pnlPct: 8, inRange: true }), "take_profit");
  assert.equal(reason({ pnlPct: 2, peakPnlPct: 5, inRange: true }), "trailing_stop");
}

testStopLossBeatsRecovery();
testOorRecoveryFlow();
testProfitAndTrailingAfterOorRecovery();

console.log("close-decider tests ok");
