// デモモード。晴れの日でも、警報が出ているときの動きを確認できるようにする。
// 差し替えるのは「入力」(現在地と警報)だけ。危険区域・避難場所・判定ルールは本番と同じものを使う。

export const DEMO_PLACES = [
  { id: "kita", label: "北区役所(危険区域の外)", lat: 35.7528, lon: 139.7337 },
  { id: "toyosu", label: "江東区 豊洲(浸水が浅い想定)", lat: 35.6545, lon: 139.796 },
  { id: "edogawa", label: "江戸川区役所(浸水3m以上の想定)", lat: 35.7067, lon: 139.8683 },
  { id: "taito", label: "台東区役所(条件付きの避難場所あり)", lat: 35.7126, lon: 139.78 },
  { id: "ome", label: "青梅市(土砂災害警戒区域)", lat: 35.794886, lon: 139.250304 },
];

export const DEMO_SCENARIOS = [
  { id: "clear", label: "警報なし", warnings: {} },
  { id: "rain2", label: "レベル2 大雨注意報", warnings: { rain: 2 } },
  { id: "rain3", label: "レベル3 大雨警報", warnings: { rain: 3 } },
  { id: "rain4", label: "レベル4 大雨危険警報", warnings: { rain: 4 } },
  { id: "rain5", label: "レベル5 大雨特別警報", warnings: { rain: 5 } },
  { id: "landslide4", label: "レベル4 土砂災害危険警報", warnings: { rain: 3, landslide: 4 } },
  { id: "surge4", label: "レベル4 高潮危険警報", warnings: { rain: 3, stormSurge: 4 } },
];

const NAMES = {
  rain: ["", "", "レベル2大雨注意報", "レベル3大雨警報", "レベル4大雨危険警報", "レベル5大雨特別警報"],
  landslide: ["", "", "レベル2土砂災害注意報", "レベル3土砂災害警報", "レベル4土砂災害危険警報", "レベル5土砂災害特別警報"],
  stormSurge: ["", "", "レベル2高潮注意報", "レベル3高潮警報", "レベル4高潮危険警報", "レベル5高潮特別警報"],
};

/** デモの警報を、本物の警報と同じ形({rain: {level, name}, ...})で作る */
export function demoWarnings(scenarioId) {
  const scenario = DEMO_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`未知のデモ: ${scenarioId}`);
  return Object.fromEntries(
    Object.keys(NAMES).map((hazard) => {
      const level = scenario.warnings[hazard] ?? 0;
      return [hazard, { level, name: level ? `${NAMES[hazard][level]}(デモ)` : null }];
    }),
  );
}
