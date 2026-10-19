import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { extractLevels, fetchWarnings, resolveArea } from "../web/src/core/jma.js";

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf-8"));
const areas = load("../web/data/jma-areas.json");
const tokyo = load("./fixtures/jma-r8-130000-20261019.json");

/** 実データと同じ形の電文を作る */
const report = (areaCode, kinds, reportDatetime = "2026-07-01T10:00:00+09:00") => ({
  reportDatetime,
  warning: { class10Items: [], class20Items: [{ areaCode, kinds }] },
});

test("市町村コードから警報の地域と府県予報区を求める", () => {
  assert.deepEqual(resolveArea(areas, "13117"), { class20Codes: ["1311700"], offices: ["130000"], names: ["北区"] });
  // 小笠原村も東京都(府県予報区 130000)
  assert.deepEqual(resolveArea(areas, "13421")?.offices, ["130000"]);
});

test("地域が分かれている市町村は、全部の地域を返す", () => {
  assert.deepEqual(resolveArea(areas, "01206")?.class20Codes, ["0120601", "0120602", "0120603"]);
});

test("政令指定都市の区は、市の地域にたどる", () => {
  // 横浜市中区 → 横浜市北部・南部
  assert.deepEqual(resolveArea(areas, "14104")?.class20Codes, ["1410011", "1410012"]);
  // 札幌市清田区 → 札幌市
  assert.deepEqual(resolveArea(areas, "01110")?.class20Codes, ["0110000"]);
  // 川崎市中原区 → 川崎市
  assert.deepEqual(resolveArea(areas, "14133")?.class20Codes, ["1413000"]);
});

test("存在しない市町村コードは null", () => {
  assert.equal(resolveArea(areas, "99999"), null);
});

test("実データ(2026-10-19 の東京都):北区は警報なし", () => {
  const result = extractLevels(tokyo, ["1311700"]);
  assert.ok(result);
  assert.deepEqual(result.levels.rain, { level: 0, name: null });
  assert.deepEqual(result.levels.landslide, { level: 0, name: null });
  assert.deepEqual(result.levels.stormSurge, { level: 0, name: null });
  assert.match(result.reportDatetime, /^2026-/);
});

test("発表中の警報のうち、一番重いレベルを採用する", () => {
  const data = [
    report("1311700", [
      { code: "10", status: "継続" },
      { code: "43", status: "発表" },
    ]),
    report("1311700", [{ code: "09", status: "発表" }]),
  ];
  const { levels } = extractLevels(data, ["1311700"]);
  assert.deepEqual(levels.rain, { level: 4, name: "レベル4大雨危険警報" });
  assert.deepEqual(levels.landslide, { level: 3, name: "レベル3土砂災害警報" });
  assert.deepEqual(levels.stormSurge, { level: 0, name: null });
});

test("解除された警報は数えない。特別警報から警報への切り替えは発表中として数える", () => {
  const data = [
    report("1311700", [
      { code: "33", status: "解除" },
      { code: "03", status: "特別警報から警報" },
    ]),
  ];
  assert.deepEqual(extractLevels(data, ["1311700"]).levels.rain, { level: 3, name: "レベル3大雨警報" });
});

test("判定に使わない警報(雷注意報など)は無視する", () => {
  const data = [report("1311700", [{ code: "14", status: "発表" }])];
  assert.equal(extractLevels(data, ["1311700"]).levels.rain.level, 0);
});

test("地域が複数あるときは、一番重いレベルを採用する", () => {
  const data = [
    {
      reportDatetime: "2026-07-01T10:00:00+09:00",
      warning: {
        class20Items: [
          { areaCode: "1410011", kinds: [{ code: "03", status: "発表" }] },
          { areaCode: "1410012", kinds: [{ code: "43", status: "発表" }] },
        ],
      },
    },
  ];
  assert.equal(extractLevels(data, ["1410011", "1410012"]).levels.rain.level, 4);
});

test("地域が見つからない・形式が違う場合は「発表なし」とせず null(不明)にする", () => {
  assert.equal(extractLevels(tokyo, ["9999900"]), null);
  assert.equal(extractLevels({ areaTypes: [] }, ["1311700"]), null);
  assert.equal(extractLevels(null, ["1311700"]), null);
});

test("取得に失敗したら例外を投げる", async () => {
  const fail = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchWarnings("130000", fail), /HTTP 503/);
  const ok = async (url) => ({ ok: true, json: async () => ({ url }) });
  assert.deepEqual(await fetchWarnings("130000", ok), { url: "https://www.jma.go.jp/bosai/warning/data/r8/130000.json" });
});
