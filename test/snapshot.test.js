import { test } from "node:test";
import assert from "node:assert/strict";

import { judge } from "../web/src/core/judge.js";
import { SNAPSHOT_VERSION, describeAge, makeSnapshot, parseSnapshot } from "../web/src/core/snapshot.js";
import { walkingRouteUrl } from "../web/src/core/shelters.js";

const out = { state: "out" };
const result = judge({
  warnings: { rain: { level: 4, name: "レベル4大雨危険警報" }, landslide: { level: 0, name: null }, stormSurge: { level: 0, name: null } },
  zones: { flood: { state: "in", depthMin: 0.5, depthLabel: "0.5〜3m" }, inland: out, stormSurge: out, sediment: out, houseCollapse: out },
});
const origin = { lat: 35.4437, lon: 139.638 };
const shelter = {
  id: "E1410000000101",
  muni: "14100",
  name: "テスト小学校",
  address: "神奈川県横浜市中区",
  lat: 35.445,
  lon: 139.64,
  hazards: ["flood"],
  note: "",
  distanceM: 230,
  conditional: false,
  routeUrl: walkingRouteUrl(origin, { lat: 35.445, lon: 139.64 }),
  alsoShelter: true, // 保存しない項目
};
const municipalities = {
  "14100": { name: "神奈川県横浜市", status: "", counts: { flood: 10 } },
  "13101": { name: "東京都千代田区", status: "", counts: {} },
};

const make = () =>
  makeSnapshot({
    result,
    origin,
    shelters: [shelter],
    coverage: null,
    muni: "14104", // 住所検索は区のコードを返す
    municipalities,
    meta: { demo: false, reportDatetime: "2026-10-22T10:00:00+09:00", warningsUnknown: false },
    savedAt: new Date("2026-10-22T05:00:00Z"),
  });

test("保存して読み戻すと、表示に必要な情報がそろっている", () => {
  const snap = parseSnapshot(JSON.stringify(make()));
  assert.ok(snap);
  assert.equal(snap.v, SNAPSHOT_VERSION);
  assert.equal(snap.result.status, "evacuate");
  assert.equal(snap.result.headline, result.headline);
  assert.equal(snap.shelters[0].routeUrl, shelter.routeUrl);
  assert.equal(snap.meta.reportDatetime, "2026-10-22T10:00:00+09:00");
});

test("区市町村は、表示に使うものだけを残す(区のコードは市にたどる)", () => {
  assert.deepEqual(make().municipalities, { "14100": { name: "神奈川県横浜市" } });
});

test("避難場所は決まった項目だけを保存する", () => {
  assert.equal("alsoShelter" in make().shelters[0], false);
});

test("壊れた・古い・書き換えられた保存データは使わない", () => {
  const good = make();
  const bad = [
    null,
    "",
    "not json",
    JSON.stringify({ ...good, v: 999 }),
    JSON.stringify({ ...good, savedAt: "いつか" }),
    JSON.stringify({ ...good, origin: { lat: "35", lon: 139 } }),
    JSON.stringify({ ...good, result: { ...good.result, status: "maybe" } }),
    JSON.stringify({ ...good, result: { ...good.result, actions: [1, 2] } }),
    JSON.stringify({ ...good, shelters: [{ ...good.shelters[0], routeUrl: "javascript:alert(1)" }] }),
    JSON.stringify({ ...good, shelters: [{ ...good.shelters[0], lat: null }] }),
  ];
  for (const text of bad) assert.equal(parseSnapshot(text), null, String(text).slice(0, 60));
});

test("保存してからの経過の表し方", () => {
  const saved = "2026-10-22T05:00:00Z";
  assert.equal(describeAge(saved, new Date("2026-10-22T05:00:20Z")), "たった今");
  assert.equal(describeAge(saved, new Date("2026-10-22T05:42:00Z")), "42分前");
  assert.equal(describeAge(saved, new Date("2026-10-22T08:10:00Z")), "3時間前");
  assert.equal(describeAge(saved, new Date("2026-10-25T05:00:00Z")), "3日前");
});
