// 気象庁の警報・注意報データを読み取る。
//
// 2026年5月29日に始まった「新たな防災気象情報」の形式に対応する。
// 旧形式(bosai/warning/data/warning/)は 2026-05-28 で更新が止まっているので使わない。
//   データ: https://www.jma.go.jp/bosai/warning/data/r8/{府県予報区コード}.json
//   コード表: 気象庁防災情報XML コード管理表 code.WeatherWarning(2026-10-19 版)

export const WARNING_URL = "https://www.jma.go.jp/bosai/warning/data/r8/{office}.json";

export const HAZARDS = ["rain", "landslide", "stormSurge"];

export const HAZARD_LABELS = {
  rain: "大雨(浸水害)",
  landslide: "土砂災害",
  stormSurge: "高潮",
};

// このアプリが判定に使う警報の種類。それ以外(雷・強風など)は判定に使わない。
export const WARNING_CODES = {
  "10": { hazard: "rain", level: 2, name: "レベル2大雨注意報" },
  "03": { hazard: "rain", level: 3, name: "レベル3大雨警報" },
  "43": { hazard: "rain", level: 4, name: "レベル4大雨危険警報" },
  "33": { hazard: "rain", level: 5, name: "レベル5大雨特別警報" },
  "29": { hazard: "landslide", level: 2, name: "レベル2土砂災害注意報" },
  "09": { hazard: "landslide", level: 3, name: "レベル3土砂災害警報" },
  "49": { hazard: "landslide", level: 4, name: "レベル4土砂災害危険警報" },
  "39": { hazard: "landslide", level: 5, name: "レベル5土砂災害特別警報" },
  "19": { hazard: "stormSurge", level: 2, name: "レベル2高潮注意報" },
  "08": { hazard: "stormSurge", level: 3, name: "レベル3高潮警報" },
  "48": { hazard: "stormSurge", level: 4, name: "レベル4高潮危険警報" },
  "38": { hazard: "stormSurge", level: 5, name: "レベル5高潮特別警報" },
};

// これ以外の状態(発表・継続・特別警報から警報 など)は「発表中」として扱う。
const INACTIVE_STATUSES = new Set(["解除", "発表警報・注意報はなし"]);

/**
 * 市町村コード(5桁)から、警報が発表される地域(class20)と府県予報区を求める。
 *
 * - 多くの市町村は「市町村コード + 00」の1地域。
 * - 一部の市町村は地域が分かれている(例: 横浜市北部・南部)。その場合は全部を返し、
 *   呼び出し側で一番重いレベルを採用する。
 * - 政令指定都市の区は、市のコードで発表されている(例: 横浜市中区 14104 → 横浜市 14100)。
 *
 * @param {Record<string, [string, string]>} areas jma-areas.json({class20: [名称, 府県予報区]})
 * @param {string} muniCd 市町村コード(5桁)
 * @returns {{class20Codes: string[], offices: string[], names: string[]} | null}
 */
export function resolveArea(areas, muniCd) {
  const muni = String(muniCd).padStart(5, "0");
  const codes = Object.keys(areas);
  let matched = codes.filter((c) => c.startsWith(muni));
  if (matched.length === 0) {
    const city = codes
      .map((c) => c.slice(0, 5))
      .filter((c5) => c5.slice(0, 3) === muni.slice(0, 3) && c5 <= muni)
      .sort()
      .at(-1);
    if (city) matched = codes.filter((c) => c.startsWith(city));
  }
  if (matched.length === 0) return null;
  matched.sort();
  return {
    class20Codes: matched,
    offices: [...new Set(matched.map((c) => areas[c][1]))],
    names: matched.map((c) => areas[c][0]),
  };
}

/**
 * 警報データから、指定した地域の災害ごとの警報レベルを取り出す。
 * 地域が複数あるときは、一番重いレベルを採用する。
 *
 * データの中に指定した地域が1つも見つからない場合は、形式が変わった可能性があるので
 * 「発表なし」とはみなさず null(不明)を返す。
 *
 * @param {unknown} data r8/{office}.json の中身(電文ごとの配列)
 * @param {string[]} class20Codes
 * @returns {{levels: Record<string, {level: number, name: string | null}>, reportDatetime: string | null} | null}
 */
export function extractLevels(data, class20Codes) {
  if (!Array.isArray(data)) return null;
  const wanted = new Set(class20Codes);
  const levels = Object.fromEntries(HAZARDS.map((h) => [h, { level: 0, name: null }]));
  let found = false;
  let reportDatetime = null;

  for (const report of data) {
    const items = report?.warning?.class20Items;
    if (!Array.isArray(items)) continue;
    if (typeof report.reportDatetime === "string" && (!reportDatetime || report.reportDatetime > reportDatetime)) {
      reportDatetime = report.reportDatetime;
    }
    for (const item of items) {
      if (!wanted.has(item?.areaCode)) continue;
      found = true;
      for (const kind of item.kinds ?? []) {
        if (!kind?.code || INACTIVE_STATUSES.has(kind.status)) continue;
        const def = WARNING_CODES[String(kind.code).padStart(2, "0")];
        if (!def) continue;
        const current = levels[def.hazard];
        if (def.level > current.level) {
          current.level = def.level;
          current.name = def.name;
        }
      }
    }
  }
  return found ? { levels, reportDatetime } : null;
}

/**
 * 府県予報区の警報データを取得する。失敗したら例外を投げる。
 * @param {string} office
 * @param {typeof fetch} fetchFn テストで差し替えられるようにする
 */
export async function fetchWarnings(office, fetchFn = fetch) {
  const res = await fetchFn(WARNING_URL.replace("{office}", office));
  if (!res.ok) throw new Error(`警報データの取得に失敗しました (HTTP ${res.status})`);
  return res.json();
}
