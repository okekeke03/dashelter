// 避難所データの読み込み範囲の計算と、避難所の選び方。
// データは scripts/build_shelters.py が2次メッシュ(約10km四方)ごとに分けて出力している。

/** 2次メッシュコード(6桁)。scripts/build_shelters.py の mesh2_code と同じ計算。 */
export function mesh2Code(lat, lon) {
  const p = Math.floor(lat * 1.5);
  const a = lat * 1.5 - p;
  const u = Math.floor(lon) - 100;
  const q = Math.floor(a * 8);
  const v = Math.floor((lon - Math.floor(lon)) * 8);
  return `${String(p).padStart(2, "0")}${String(u).padStart(2, "0")}${q}${v}`;
}

/** 2次メッシュの範囲 [南, 西, 北, 東] */
export function mesh2Bounds(code) {
  const p = Number(code.slice(0, 2));
  const u = Number(code.slice(2, 4));
  const q = Number(code[4]);
  const v = Number(code[5]);
  const south = (p + q / 8) / 1.5;
  const west = 100 + u + v / 8;
  return [south, west, south + 1 / 12, west + 1 / 8];
}

/** 現在地のメッシュと、その周り 3×3 マスのメッシュコード */
export function meshesAround(lat, lon) {
  const [south, west, north, east] = mesh2Bounds(mesh2Code(lat, lon));
  const cLat = (south + north) / 2;
  const cLon = (west + east) / 2;
  const codes = [];
  for (const dLat of [-1, 0, 1]) {
    for (const dLon of [-1, 0, 1]) {
      codes.push(mesh2Code(cLat + dLat / 12, cLon + dLon / 8));
    }
  }
  return codes;
}

/** 距離の表示(「約630m」「約1.2km」)。AI の出力の検証でも同じ表記を使う */
export const formatDistance = (m) => (m < 1000 ? `約${Math.round(m / 10) * 10}m` : `約${(m / 1000).toFixed(1)}km`);

export const DESIGNATION_LABELS = {
  flood: "洪水",
  inland_flood: "内水氾濫",
  landslide: "土砂災害",
  storm_surge: "高潮",
  earthquake: "地震",
  tsunami: "津波",
  fire: "大規模な火事",
  volcano: "火山",
};

/** 2点間の距離(メートル、球面上の最短距離) */
export function distanceMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// 備考に「開設しない」などの条件が書かれている避難所(例: 荒川が氾濫するおそれがある場合は開設しない)
const CONDITIONAL_NOTE = /開設しない|開設されない|使用しない|使用できない|利用できない|使用不可|利用不可/;

export function isConditional(shelter) {
  return CONDITIONAL_NOTE.test(shelter.note ?? "");
}

/**
 * Google マップの徒歩ルート。目的地にピンが立ち、スマホでは dir_action=navigate でそのままナビが始まる
 * (出発地が端末の現在地から離れている場合や PC では、ルートの表示まで)。
 */
export function walkingRouteUrl(origin, dest) {
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lon}`,
    destination: `${dest.lat},${dest.lon}`,
    travelmode: "walking",
    dir_action: "navigate",
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

export const HAZARD_MAP_PORTAL = {
  label: "わがまちハザードマップ(国土交通省)",
  url: "https://disaportal.gsi.go.jp/hazardmap/",
};

/** 「東京都江戸川区」→「江戸川区」 */
export function municipalityName(municipalities, muni) {
  const name = municipalities?.[muni]?.name;
  return name ? name.replace(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/, "") : null;
}

/**
 * 現在地の区市町村に、必要な種別の避難場所がデータ上あるかを調べ、なければ注意を返す。
 * (国土地理院のデータには、指定緊急避難場所を公開していない区市町村や、洪水などの指定が 0 件の区市町村がある)
 *
 * @param {Record<string, {name: string, status: string, counts: Record<string, number>}>} municipalities index.json の municipalities
 * @param {string | null} muni 現在地の市町村コード
 * @param {string[][]} requirements
 * @returns {{text: string, link: {label: string, url: string}} | null}
 */
export function coverageNotice(municipalities, muni, requirements) {
  if (requirements.length === 0) return null;
  const entry = muni ? municipalities?.[muni] : null;
  if (!entry) {
    return {
      text: "現在地の区市町村は、このアプリの避難場所データの対象外です(現在は東京都のみ)。区市町村のハザードマップと避難情報を確認してください。",
      link: HAZARD_MAP_PORTAL,
    };
  }
  const name = municipalityName(municipalities, muni);
  const total = Object.values(entry.counts).reduce((a, b) => a + b, 0);
  const missing = total === 0 || requirements.some((anyOf) => anyOf.every((h) => !entry.counts[h]));
  if (!missing) return null;
  const why = entry.status ? `国土地理院のデータでは「${entry.status}」となっていて、` : "";
  return {
    text: `${name}は、${why}この災害に対応した避難場所がデータ上ありません。下の一覧は他の区市町村の避難場所です。${name}のハザードマップと避難情報(区域外への広域避難など)を必ず確認してください。`,
    link: HAZARD_MAP_PORTAL,
  };
}

/**
 * 条件に合う避難所を、近い順に選ぶ。
 *
 * - requirements: 災害ごとの「指定されているべき種別」。各要素のどれか1つに指定されていればよく、
 *   全部の災害について満たす避難所だけを残す。空なら全部の避難所が対象。
 * - 備考に条件がある避難所は、条件のない避難所より後ろに並べる。
 *
 * @param {Array<{id: string, name: string, lat: number, lon: number, hazards: string[], note?: string}>} shelters
 * @param {{lat: number, lon: number}} origin
 * @param {string[][]} requirements
 * @param {number} limit
 */
export function selectShelters(shelters, origin, requirements, limit = 3) {
  return shelters
    .filter((s) => requirements.every((anyOf) => anyOf.some((h) => s.hazards.includes(h))))
    .map((s) => ({
      ...s,
      distanceM: distanceMeters(origin, s),
      conditional: isConditional(s),
      routeUrl: walkingRouteUrl(origin, s),
    }))
    .sort((a, b) => a.conditional - b.conditional || a.distanceM - b.distanceM)
    .slice(0, limit);
}
