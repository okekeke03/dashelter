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

export function walkingRouteUrl(origin, dest) {
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lon}`,
    destination: `${dest.lat},${dest.lon}`,
    travelmode: "walking",
  });
  return `https://www.google.com/maps/dir/?${params}`;
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
