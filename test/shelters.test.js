import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  HAZARD_MAP_PORTAL,
  coverageNotice,
  registeredMuni,
  distanceMeters,
  mesh2Bounds,
  mesh2Code,
  meshesAround,
  municipalityName,
  selectShelters,
  walkingRouteUrl,
} from "../web/src/core/shelters.js";

const dataDir = new URL("../web/data/shelters/", import.meta.url);
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

test("Google マップの徒歩ルート URL(目的地にピン、スマホではそのままナビ開始)", () => {
  assert.equal(
    walkingRouteUrl({ lat: 35.1, lon: 139.2 }, { lat: 35.3, lon: 139.4 }),
    "https://www.google.com/maps/dir/?api=1&origin=35.1%2C139.2&destination=35.3%2C139.4&travelmode=walking&dir_action=navigate",
  );
});

const index = JSON.parse(readFileSync(new URL("index.json", dataDir), "utf-8"));
const RAIN = [["flood", "inland_flood"]];

test("区市町村名から都道府県名を外す", () => {
  assert.equal(municipalityName(index.municipalities, "13123"), "江戸川区");
  assert.equal(municipalityName(index.municipalities, "13201"), "八王子市");
  assert.equal(municipalityName(index.municipalities, "99999"), null);
});

test("データの空白:指定緊急避難場所を公開していない区は、その旨を伝える(江東区)", () => {
  const notice = coverageNotice(index.municipalities, "13108", RAIN);
  assert.match(notice.text, /^江東区は、国土地理院のデータでは「指定避難所データのみ公開」となっていて/);
  assert.equal(notice.link, HAZARD_MAP_PORTAL);
});

test("データの空白:データはあるが大雨用の指定がない区も伝える(江戸川区)", () => {
  assert.match(coverageNotice(index.municipalities, "13123", RAIN).text, /^江戸川区は、この災害に対応した避難場所がデータ上ありません/);
});

test("データの空白:必要な種別の避難場所がある区では注意を出さない", () => {
  assert.equal(coverageNotice(index.municipalities, "13118", RAIN), null); // 荒川区
  // 避難が不要な判定(要件なし)では出さない
  assert.equal(coverageNotice(index.municipalities, "13108", []), null);
});

test("データの空白:災害ごとに判断する(中央区は洪水の指定はあるが、土砂災害の指定がない)", () => {
  assert.equal(coverageNotice(index.municipalities, "13102", RAIN), null);
  assert.ok(coverageNotice(index.municipalities, "13102", [["landslide"]]));
});

test("全国のデータが入っている(47都道府県)", () => {
  const prefs = new Set(Object.keys(index.municipalities).map((c) => c.slice(0, 2)));
  assert.equal(prefs.size, 47);
  assert.equal(index.source.prefectures, "all");
  assert.ok(index.count > 100000, String(index.count));
});

test("政令指定都市の区のコードは、市のコードにそろえる(避難場所データは市の単位)", () => {
  assert.equal(registeredMuni(index.municipalities, "14104"), "14100"); // 横浜市中区 → 横浜市
  assert.equal(registeredMuni(index.municipalities, "14133"), "14130"); // 川崎市中原区 → 川崎市
  assert.equal(registeredMuni(index.municipalities, "01110"), "01100"); // 札幌市清田区 → 札幌市
  assert.equal(registeredMuni(index.municipalities, "13117"), "13117"); // 東京の特別区はそのまま
  assert.equal(registeredMuni(index.municipalities, "99999"), null);
  assert.equal(municipalityName(index.municipalities, "14104"), "横浜市");
});

test("データの空白:政令指定都市の区にいても、市のデータで判断する", () => {
  // 横浜市には洪水などに指定された避難場所があるので、注意は出さない
  assert.equal(coverageNotice(index.municipalities, "14104", RAIN), null);
});

test("データの空白:現在地の区市町村が分からないときは、その旨を伝える", () => {
  assert.match(coverageNotice(index.municipalities, null, RAIN).text, /見つかりませんでした/);
  assert.match(coverageNotice(index.municipalities, "99999", RAIN).text, /見つかりませんでした/);
});
