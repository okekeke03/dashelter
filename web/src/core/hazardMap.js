// 重ねるハザードマップ(国土交通省・国土地理院)のタイル画像から、
// ある地点が危険な区域の中にあるかを判定する。
//
// タイルは地点ごとの色で区分を表しているので、その地点のピクセルの色を見る。
// 色の値は 2026-10-19 に東京都内のタイルで実際に確認したもの。
//   https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/opendata.html

export const TILE_URL = "https://disaportaldata.gsi.go.jp/raster/{path}/{z}/{x}/{y}.png";
export const TILE_ZOOM = 16;

export const LAYERS = {
  flood: { path: "01_flood_l2_shinsuishin_data", type: "depth", label: "洪水浸水想定区域(想定最大規模)" },
  inland: { path: "02_naisui_data", type: "depth", label: "内水浸水想定区域" },
  stormSurge: { path: "03_hightide_l2_shinsuishin_data", type: "depth", label: "高潮浸水想定区域" },
  debrisFlow: { path: "05_dosekiryukeikaikuiki", type: "sediment", label: "土砂災害警戒区域(土石流)" },
  steepSlope: { path: "05_kyukeishakeikaikuiki", type: "sediment", label: "土砂災害警戒区域(急傾斜地の崩壊)" },
  landslide: { path: "05_jisuberikeikaikuiki", type: "sediment", label: "土砂災害警戒区域(地すべり)" },
  collapseFlow: { path: "01_flood_l2_kaokutoukai_hanran_data", type: "presence", label: "家屋倒壊等氾濫想定区域(氾濫流)" },
  collapseErosion: { path: "01_flood_l2_kaokutoukai_kagan_data", type: "presence", label: "家屋倒壊等氾濫想定区域(河岸侵食)" },
};

// 浸水深の凡例。min/max はメートル。
const DEPTH_CLASSES = [
  { rgb: [247, 245, 169], min: 0, max: 0.5, label: "0.5m未満" },
  { rgb: [255, 216, 192], min: 0.5, max: 3, label: "0.5〜3m" },
  { rgb: [255, 183, 183], min: 3, max: 5, label: "3〜5m" },
  { rgb: [255, 145, 145], min: 5, max: 10, label: "5〜10m" },
  { rgb: [242, 133, 201], min: 10, max: 20, label: "10〜20m" },
  { rgb: [220, 122, 220], min: 20, max: null, label: "20m以上" },
];

// 土砂災害「特別警戒区域」の色(土石流・急傾斜地)。それ以外の色は「警戒区域」とみなす。
const SEDIMENT_SPECIAL_RGB = [
  [165, 0, 33],
  [250, 40, 0],
];

// 区域の境目は半透明でぼかされている。半分以上不透明なら区域の中とみなす。
const MIN_ALPHA = 128;
const COLOR_TOLERANCE = 12;

const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= COLOR_TOLERANCE;

/**
 * 区域の判定結果。
 * - {state: "in", ...}    区域の中
 * - {state: "out"}        区域の外(タイルが存在しない場合も含む)
 * - {state: "unknown"}    取得できなかった
 * @typedef {{state: "in", depthMin?: number | null, depthLabel?: string, special?: boolean} | {state: "out"} | {state: "unknown"}} Zone
 */

/**
 * ピクセルの色を、そのレイヤーの区分に変換する。
 * @param {keyof typeof LAYERS} layer
 * @param {[number, number, number, number]} rgba
 * @returns {Zone}
 */
export function classifyPixel(layer, rgba) {
  const type = LAYERS[layer]?.type;
  if (!type) throw new Error(`未知のレイヤー: ${layer}`);
  if (rgba[3] < MIN_ALPHA) return { state: "out" };
  if (type === "depth") {
    const cls = DEPTH_CLASSES.find((c) => near(c.rgb, rgba));
    // 凡例にない色(古い凡例のデータなど)も区域の中として扱う。深さは不明にする。
    return cls
      ? { state: "in", depthMin: cls.min, depthLabel: cls.label }
      : { state: "in", depthMin: null, depthLabel: "深さ不明" };
  }
  if (type === "sediment") {
    return { state: "in", special: SEDIMENT_SPECIAL_RGB.some((c) => near(c, rgba)) };
  }
  return { state: "in" };
}

/**
 * 同じ種類の区域の判定をまとめる。
 * 1つでも「中」なら中(深さは一番深いもの、特別警戒区域が1つでもあれば特別警戒区域)。
 * 全部「外」なら外。それ以外は不明。
 * @param {Zone[]} zones
 * @returns {Zone}
 */
export function mergeZones(zones) {
  const inside = zones.filter((z) => z.state === "in");
  if (inside.length > 0) {
    const merged = { state: "in" };
    if (inside.some((z) => "depthMin" in z)) {
      const depths = inside.filter((z) => "depthMin" in z);
      // 深さ不明が1つでもあれば不明にする(安全側に倒す)
      const unknownDepth = depths.find((z) => z.depthMin === null);
      const deepest = depths.reduce((a, b) => ((b.depthMin ?? -1) > (a.depthMin ?? -1) ? b : a));
      merged.depthMin = unknownDepth ? null : deepest.depthMin;
      merged.depthLabel = unknownDepth ? "深さ不明" : deepest.depthLabel;
    }
    if (inside.some((z) => "special" in z)) merged.special = inside.some((z) => z.special);
    return merged;
  }
  return zones.length > 0 && zones.every((z) => z.state === "out") ? { state: "out" } : { state: "unknown" };
}

/**
 * 緯度経度から、タイル番号とタイル内のピクセル位置を求める(Webメルカトル)。
 * @returns {{x: number, y: number, px: number, py: number}}
 */
export function tilePosition(lat, lon, z = TILE_ZOOM) {
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  return { x, y, px: Math.floor((fx - x) * 256), py: Math.floor((fy - y) * 256) };
}

export function tileUrl(layer, { x, y }, z = TILE_ZOOM) {
  return TILE_URL.replace("{path}", LAYERS[layer].path).replace("{z}", z).replace("{x}", x).replace("{y}", y);
}
