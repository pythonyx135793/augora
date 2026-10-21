import assert from "node:assert/strict";
import test from "node:test";
import { units } from "../../frontend/soroban.js";

const formatError = "Enter a valid XLM amount with no more than 7 decimal places.";
const zeroError = "Position amount must be greater than zero.";

for (const [input, message] of [
  ["0", zeroError],
  ["0.0000000", zeroError],
  ["-1", formatError],
  ["1.12345678", formatError],
]) {
  test(`xlmToStroops rejects ${JSON.stringify(input)} with the correct error`, () => {
    assert.throws(() => units.xlmToStroops(input), { name: "Error", message });
  });
}

for (const [input, expected] of [
  ["0.0000001", 1n],
  ["1", 10_000_000n],
  ["1.1234567", 11_234_567n],
  ["9007199254740993", 90_071_992_547_409_930_000_000n],
]) {
  test(`xlmToStroops converts ${JSON.stringify(input)} to exact BigInt stroops`, () => {
    assert.equal(units.xlmToStroops(input), expected);
  });
}
