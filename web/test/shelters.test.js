import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { distanceMeters, mesh2Bounds, mesh2Code, meshesAround, selectShelters, walkingRouteUrl } from "../src/core/shelters.js";

const dataDir = new URL("../public/data/shelters/", import.meta.url);
const meshFiles = readdirSync(dataDir).filter((f) => /^\d{6}\.json$/.test(f));
const loadMesh = (code) => JSON.parse(readFileSync(new URL(`${code}.json`, dataDir), "utf-8"));

test("2次メッシュコード:Python 版と同じ結果になる", () => {
  assert.equal(mesh2Code(35.6812, 139.7671), "533946");
  assert.equal(mesh2Code(27.0944, 142.1917), "404251");
});

test("出力済みの避難所データは、すべてファイル名のメッシュに入っている(Python と JS の計算が一致)", () => {
  assert.ok(meshFiles.length > 0);
  for (const file of meshFiles) {
    const code = file.slice(0, 6);
    for (const s of loadMesh(code)) assert.equal(mesh2Code(s.lat, s.lon), code, `${s.name}`);
  }
});

test("周り 3×3 マスのメッシュを返す(1次メッシュの境目もまたぐ)", () => {
  const codes = meshesAround(35.6812, 139.95); // 533947(1次メッシュ 5339 の東端)
  assert.equal(codes.length, 9);
  assert.equal(new Set(codes).size, 9);
  assert.ok(codes.includes("533947"));
  // 533947 の右(東)は、隣の1次メッシュ 5340 の 534040
  assert.ok(codes.includes("534040"));
  for (const code of codes) {
    const [s, w, n, e] = mesh2Bounds(code);
    assert.ok(n - s > 0.08 && e - w > 0.12);
  }
});

test("距離:東京駅から北区役所まで約9km", () => {
  const d = distanceMeters({ lat: 35.6812, lon: 139.7671 }, { lat: 35.7528, lon: 139.7337 });
  assert.ok(d > 8000 && d < 9000, String(d));
});

test("避難所の選び方:指定された種別だけに絞り、近い順に並べる", () => {
  const origin = { lat: 35.7528, lon: 139.7337 }; // 北区役所
  const shelters = meshesAround(origin.lat, origin.lon)
    .filter((c) => meshFiles.includes(`${c}.json`))
    .flatMap(loadMesh);
  const picked = selectShelters(shelters, origin, [["flood", "inland_flood"]], 3);
  assert.equal(picked.length, 3);
  for (const s of picked) assert.ok(s.hazards.includes("flood") || s.hazards.includes("inland_flood"));
  assert.ok(picked[0].distanceM <= picked[1].distanceM && picked[1].distanceM <= picked[2].distanceM);
  assert.match(picked[0].routeUrl, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&/);
});

test("避難所の選び方:複数の災害があれば、全部に対応した避難所だけ", () => {
  const shelters = [
    { id: "a", name: "A", lat: 35.7, lon: 139.7, hazards: ["flood"], note: "" },
    { id: "b", name: "B", lat: 35.71, lon: 139.7, hazards: ["flood", "landslide"], note: "" },
  ];
  const picked = selectShelters(shelters, { lat: 35.7, lon: 139.7 }, [["flood", "inland_flood"], ["landslide"]]);
  assert.deepEqual(picked.map((s) => s.id), ["b"]);
});

test("避難所の選び方:「開設しない」条件のある避難所は後ろに回す(台東区の実データ)", () => {
  const origin = { lat: 35.7126, lon: 139.7800 }; // 台東区役所付近
  const shelters = meshesAround(origin.lat, origin.lon)
    .filter((c) => meshFiles.includes(`${c}.json`))
    .flatMap(loadMesh);
  const conditional = shelters.filter((s) => s.note.includes("開設しない"));
  assert.ok(conditional.length >= 14);

  const picked = selectShelters(shelters, origin, [["flood", "inland_flood"]], shelters.length);
  const firstConditional = picked.findIndex((s) => s.conditional);
  assert.ok(firstConditional > 0);
  assert.ok(picked.slice(firstConditional).every((s) => s.conditional));
  // 近くても、条件付きの避難所は上位3件に入らない
  assert.ok(selectShelters(shelters, origin, [["flood", "inland_flood"]], 3).every((s) => !s.conditional));
});

test("Google マップの徒歩ルート URL", () => {
  assert.equal(
    walkingRouteUrl({ lat: 35.1, lon: 139.2 }, { lat: 35.3, lon: 139.4 }),
    "https://www.google.com/maps/dir/?api=1&origin=35.1%2C139.2&destination=35.3%2C139.4&travelmode=walking",
  );
});
