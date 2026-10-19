import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyPixel, mergeZones, tilePosition, tileUrl } from "../src/core/hazardMap.js";

test("浸水深の色を区分に変換する(2026-10-19 に実タイルで確認した色)", () => {
  assert.deepEqual(classifyPixel("flood", [247, 245, 169, 255]), { state: "in", depthMin: 0, depthLabel: "0.5m未満" });
  assert.deepEqual(classifyPixel("flood", [255, 216, 192, 255]), { state: "in", depthMin: 0.5, depthLabel: "0.5〜3m" });
  assert.deepEqual(classifyPixel("flood", [255, 183, 183, 255]), { state: "in", depthMin: 3, depthLabel: "3〜5m" });
  assert.deepEqual(classifyPixel("stormSurge", [255, 145, 145, 255]), { state: "in", depthMin: 5, depthLabel: "5〜10m" });
  assert.deepEqual(classifyPixel("flood", [242, 133, 201, 255]), { state: "in", depthMin: 10, depthLabel: "10〜20m" });
});

test("凡例にない色も区域の中として扱い、深さは不明にする", () => {
  assert.deepEqual(classifyPixel("stormSurge", [248, 225, 166, 255]), { state: "in", depthMin: null, depthLabel: "深さ不明" });
});

test("透明・半分以上透明なピクセルは区域の外", () => {
  assert.deepEqual(classifyPixel("flood", [0, 0, 0, 0]), { state: "out" });
  assert.deepEqual(classifyPixel("debrisFlow", [255, 255, 0, 2]), { state: "out" });
});

test("土砂災害:赤系は特別警戒区域、それ以外は警戒区域", () => {
  assert.deepEqual(classifyPixel("debrisFlow", [165, 0, 33, 255]), { state: "in", special: true });
  assert.deepEqual(classifyPixel("steepSlope", [250, 40, 0, 255]), { state: "in", special: true });
  assert.deepEqual(classifyPixel("debrisFlow", [230, 200, 50, 255]), { state: "in", special: false });
  assert.deepEqual(classifyPixel("landslide", [255, 153, 0, 255]), { state: "in", special: false });
});

test("家屋倒壊等氾濫想定区域は、色があれば区域の中", () => {
  assert.deepEqual(classifyPixel("collapseFlow", [255, 0, 0, 255]), { state: "in" });
});

test("区域の判定をまとめる", () => {
  const out = { state: "out" };
  const unknown = { state: "unknown" };
  const shallow = { state: "in", depthMin: 0.5, depthLabel: "0.5〜3m" };
  const deep = { state: "in", depthMin: 3, depthLabel: "3〜5m" };
  const noDepth = { state: "in", depthMin: null, depthLabel: "深さ不明" };

  assert.deepEqual(mergeZones([out, out]), out);
  assert.deepEqual(mergeZones([out, unknown]), unknown);
  assert.deepEqual(mergeZones([]), unknown);
  // 1つでも中なら中。深さは深いほう
  assert.deepEqual(mergeZones([unknown, shallow]), shallow);
  assert.deepEqual(mergeZones([shallow, deep]), deep);
  // 深さ不明が混ざれば不明(安全側)
  assert.deepEqual(mergeZones([deep, noDepth]), noDepth);
  // 特別警戒区域が1つでもあれば特別警戒区域
  assert.deepEqual(mergeZones([{ state: "in", special: false }, { state: "in", special: true }]), { state: "in", special: true });
});

test("緯度経度からタイルの位置を求める", () => {
  // 東京駅(ズーム16)
  const pos = tilePosition(35.6812, 139.7671, 16);
  assert.deepEqual({ x: pos.x, y: pos.y }, { x: 58211, y: 25806 });
  assert.ok(pos.px >= 0 && pos.px < 256 && pos.py >= 0 && pos.py < 256);
  assert.equal(
    tileUrl("flood", pos, 16),
    "https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/16/58211/25806.png",
  );
});
