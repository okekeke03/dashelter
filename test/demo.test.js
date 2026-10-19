import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_SCENARIOS, demoWarnings } from "../web/src/core/demo.js";
import { judge } from "../web/src/core/judge.js";

test("デモの警報は、本物と同じ形で作られ、名前に(デモ)が付く", () => {
  assert.deepEqual(demoWarnings("rain4"), {
    rain: { level: 4, name: "レベル4大雨危険警報(デモ)" },
    landslide: { level: 0, name: null },
    stormSurge: { level: 0, name: null },
  });
});

test("すべてのデモは判定まで通る", () => {
  const out = { state: "out" };
  const zones = { flood: { state: "in", depthMin: 0.5, depthLabel: "0.5〜3m" }, inland: out, stormSurge: out, sediment: out, houseCollapse: out };
  for (const s of DEMO_SCENARIOS) {
    assert.ok(judge({ warnings: demoWarnings(s.id), zones }).headline, s.id);
  }
  assert.equal(judge({ warnings: demoWarnings("rain4"), zones }).status, "evacuate");
});

test("未知のデモはエラー", () => {
  assert.throws(() => demoWarnings("nope"));
});
