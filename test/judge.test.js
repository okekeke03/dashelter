import { test } from "node:test";
import assert from "node:assert/strict";

import { DISCLAIMER, HEADLINES, RIVER_NOTICE, judge, judgeHazard } from "../web/src/core/judge.js";

const IN = { state: "in", depthMin: 0.5, depthLabel: "0.5〜3m" };
const IN_DEEP = { state: "in", depthMin: 3, depthLabel: "3〜5m" };
const IN_NO_DEPTH = { state: "in", depthMin: null, depthLabel: "深さ不明" };
const OUT = { state: "out" };
const UNKNOWN = { state: "unknown" };

const noWarnings = () => ({
  rain: { level: 0, name: null },
  landslide: { level: 0, name: null },
  stormSurge: { level: 0, name: null },
});
const allOut = () => ({ flood: OUT, inland: OUT, stormSurge: OUT, sediment: OUT, houseCollapse: OUT });

const run = ({ warnings = {}, zones = {} } = {}) =>
  judge({
    warnings: warnings === null ? null : { ...noWarnings(), ...warnings },
    zones: { ...allOut(), ...zones },
  });

test("判定表:警報レベル × 区域の中・外・不明", () => {
  const table = [
    // [レベル, 区域, 期待する判定]
    [0, IN, "safe"],
    [2, IN, "caution"],
    [2, OUT, "caution"],
    [3, IN, "prepare"],
    [3, OUT, "stay"],
    [3, UNKNOWN, "unknown"],
    [4, IN, "evacuate"],
    [4, OUT, "stay"],
    [4, UNKNOWN, "unknown"],
    [5, IN, "emergency"],
    [5, OUT, "stay"],
  ];
  for (const [level, zone, expected] of table) {
    assert.equal(judgeHazard({ level, name: "x" }, zone), expected, `レベル${level} × ${zone.state}`);
  }
  assert.equal(judgeHazard(null, IN), "unknown");
});

test("レベル4 × 危険区域の中:避難。見出しは行動を伝える", () => {
  const r = run({ warnings: { rain: { level: 4, name: "レベル4大雨危険警報" } }, zones: { flood: IN } });
  assert.equal(r.status, "evacuate");
  assert.equal(r.headline, "ここは危険な区域です。今すぐ避難してください");
});

test("レベル4 × 危険区域の外:とどまる。自治体の避難指示に従うことも伝える", () => {
  const r = run({ warnings: { rain: { level: 4, name: "レベル4大雨危険警報" } } });
  assert.equal(r.status, "stay");
  assert.equal(r.headline, "ここは危険区域の外です。移動せず、今いる場所にとどまってください");
  assert.ok(r.actions.some((a) => a.includes("自治体から避難指示")));
  assert.deepEqual(r.shelterRequirements, []);
});

test("大雨(浸水害)は、洪水・内水どちらかの区域に入っていれば区域の中", () => {
  const r = run({ warnings: { rain: { level: 4, name: "x" } }, zones: { flood: OUT, inland: IN } });
  assert.equal(r.status, "evacuate");
});

test("警報が取得できないときは「安全」と言わず、判定できないと伝える", () => {
  const r = run({ warnings: null });
  assert.equal(r.status, "unknown");
  assert.equal(r.headline, HEADLINES.unknown);
  assert.ok(r.actions.some((a) => a.includes("警報の情報を取得できませんでした")));
});

test("区域が確認できず、警報がレベル3以上なら判定できない", () => {
  const r = run({ warnings: { landslide: { level: 4, name: "x" } }, zones: { sediment: UNKNOWN } });
  assert.equal(r.status, "unknown");
  assert.ok(r.actions.some((a) => a.includes("ハザードマップで確認")));
});

test("災害ごとの判定のうち、一番重いものを採用する", () => {
  const r = run({
    warnings: { rain: { level: 3, name: "x" }, landslide: { level: 4, name: "y" } },
    zones: { flood: IN, sediment: { state: "in", special: false } },
  });
  assert.equal(r.status, "evacuate");
  // 避難所は「きっかけになった災害(土砂災害)」に対応したものを探す
  assert.deepEqual(r.shelterRequirements, [["landslide"]]);
});

test("土砂災害で避難するときは、上の階ではなく区域の外へ避難するよう伝える", () => {
  const r = run({ warnings: { landslide: { level: 4, name: "x" } }, zones: { sediment: { state: "in", special: false } } });
  assert.ok(r.actions.some((a) => a.includes("危険区域の外へ避難")));
});

test("屋内安全確保:浸水が浅く、家屋倒壊のおそれがなければ選択肢として伝える", () => {
  const r = run({ warnings: { rain: { level: 4, name: "x" } }, zones: { flood: IN } });
  assert.equal(r.verticalEvacuation, "allowed");
  assert.ok(r.actions.some((a) => a.includes("屋内安全確保")));
});

test("屋内安全確保:浸水3m以上・家屋倒壊等氾濫想定区域では案内しない", () => {
  const deep = run({ warnings: { rain: { level: 4, name: "x" } }, zones: { flood: IN_DEEP } });
  assert.equal(deep.verticalEvacuation, "not-allowed");
  assert.ok(deep.actions.some((a) => a.includes("浸水が3m以上")));
  assert.ok(!deep.actions.some((a) => a.includes("屋内安全確保")));

  const collapse = run({ warnings: { rain: { level: 4, name: "x" } }, zones: { flood: IN, houseCollapse: { state: "in" } } });
  assert.equal(collapse.verticalEvacuation, "not-allowed");
  assert.ok(collapse.actions.some((a) => a.includes("家屋が倒壊するおそれ")));
});

test("屋内安全確保:深さや家屋倒壊の区域が分からなければ案内しない", () => {
  const noDepth = run({ warnings: { rain: { level: 4, name: "x" } }, zones: { flood: IN_NO_DEPTH } });
  assert.equal(noDepth.verticalEvacuation, "unknown");
  const noCollapse = run({ warnings: { rain: { level: 4, name: "x" } }, zones: { flood: IN, houseCollapse: UNKNOWN } });
  assert.equal(noCollapse.verticalEvacuation, "unknown");
  for (const r of [noDepth, noCollapse]) assert.ok(!r.actions.some((a) => a.includes("屋内安全確保")));
});

test("洪水浸水想定区域の中なら、判定とは別に川の氾濫についての注意を出す", () => {
  assert.deepEqual(run({ zones: { flood: IN } }).notices, [RIVER_NOTICE]);
  assert.deepEqual(run().notices, []);
});

test("どの判定でも、最終判断はご自身で、という注意を付ける", () => {
  const cases = [
    run(),
    run({ warnings: null }),
    run({ warnings: { rain: { level: 5, name: "x" } }, zones: { flood: IN } }),
    run({ warnings: { stormSurge: { level: 4, name: "x" } } }),
  ];
  for (const r of cases) assert.equal(r.disclaimer, DISCLAIMER);
});

test("災害ごとの内訳を返す", () => {
  const r = run({ warnings: { stormSurge: { level: 3, name: "レベル3高潮警報" } }, zones: { stormSurge: IN } });
  assert.equal(r.status, "prepare");
  const surge = r.hazards.find((h) => h.hazard === "stormSurge");
  assert.deepEqual(
    { label: surge.label, level: surge.level, warningName: surge.warningName, status: surge.status },
    { label: "高潮", level: 3, warningName: "レベル3高潮警報", status: "prepare" },
  );
  assert.deepEqual(r.shelterRequirements, [["storm_surge"]]);
});
