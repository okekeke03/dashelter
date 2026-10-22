// ブラウザで外部データを取得する部分。判定ロジック(core/)からは分けておく。
// どの取得も、失敗したら「不明」として扱えるように null や {state: "unknown"} を返す。

import { extractLevels, fetchWarnings, resolveArea } from "./core/jma.js";
import { LAYERS, classifyPixel, mergeZones, tilePosition, tileUrl } from "./core/hazardMap.js";
import { meshesAround } from "./core/shelters.js";

const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} の取得に失敗しました (HTTP ${res.status})`);
  return res.json();
};

const cache = new Map();
const once = (key, load) => {
  if (!cache.has(key)) cache.set(key, load().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key);
};

export const loadShelterIndex = () => once("index", () => getJson("data/shelters/index.json"));
const loadJmaAreas = () => once("areas", () => getJson("data/jma-areas.json"));

/** 現在地(端末の位置情報) */
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("このブラウザは位置情報に対応していません"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "位置情報の利用が許可されていません。ブラウザの設定で許可するか、デモモードで試してください"
              : "現在地を取得できませんでした",
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

/** 市町村コード(サーバー処理経由で国土地理院の住所検索を使う) */
export async function getMunicipality({ lat, lon }) {
  try {
    const { muniCd } = await getJson(`api/municipality?lat=${lat}&lon=${lon}`);
    return muniCd;
  } catch {
    return null;
  }
}

/**
 * 現在地の市町村に出ている警報レベル。取得できなければ null(不明)。
 * @returns {Promise<{levels: object, reportDatetime: string | null} | null>}
 */
export async function getWarnings(muniCd) {
  if (!muniCd) return null;
  try {
    const area = resolveArea(await loadJmaAreas(), muniCd);
    if (!area) return null;
    const reports = (await Promise.all(area.offices.map((o) => fetchWarnings(o)))).flat();
    return extractLevels(reports, area.class20Codes);
  } catch {
    return null;
  }
}

// GPS の誤差を考えて、地点の周り ±2 ピクセル(ズーム16で約±5m)を調べ、1つでも区域の中なら中とする
const SAMPLE_RADIUS = 2;

async function readTileZone(layer, lat, lon) {
  const pos = tilePosition(lat, lon);
  let res;
  try {
    res = await fetch(tileUrl(layer, pos));
  } catch {
    return { state: "unknown" };
  }
  // その場所にデータがないタイルは 404 になる(= 区域の外)
  if (res.status === 404) return { state: "out" };
  if (!res.ok) return { state: "unknown" };
  try {
    const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const size = SAMPLE_RADIUS * 2 + 1;
    const x0 = Math.min(Math.max(pos.px - SAMPLE_RADIUS, 0), bitmap.width - size);
    const y0 = Math.min(Math.max(pos.py - SAMPLE_RADIUS, 0), bitmap.height - size);
    const { data } = ctx.getImageData(x0, y0, size, size);
    const zones = [];
    for (let i = 0; i < data.length; i += 4) zones.push(classifyPixel(layer, [data[i], data[i + 1], data[i + 2], data[i + 3]]));
    return mergeZones(zones);
  } catch {
    return { state: "unknown" };
  }
}

/** 現在地が、各種の危険区域の中にあるか */
export async function getZones({ lat, lon }) {
  const names = Object.keys(LAYERS);
  const results = await Promise.all(names.map((layer) => readTileZone(layer, lat, lon)));
  const z = Object.fromEntries(names.map((name, i) => [name, results[i]]));
  return {
    flood: z.flood,
    inland: z.inland,
    stormSurge: z.stormSurge,
    sediment: mergeZones([z.debrisFlow, z.steepSlope, z.landslide]),
    houseCollapse: mergeZones([z.collapseFlow, z.collapseErosion]),
  };
}

/**
 * AI による説明(サーバー側で事実データを作り直し、出力を検証したもの)。
 * 使えない・失敗したときは {ok: false, reason} を返す。判定には影響しない。
 */
export async function requestExplanation(payload) {
  try {
    const res = await fetch("api/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    return body ?? { ok: false, reason: `HTTP ${res.status}` };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** 現在地の周りの避難場所(データがあるメッシュだけ取得する) */
export async function getSheltersAround({ lat, lon }) {
  const index = await loadShelterIndex();
  const available = new Set(index.meshes);
  const codes = meshesAround(lat, lon).filter((c) => available.has(c));
  const lists = await Promise.all(codes.map((c) => once(`mesh:${c}`, () => getJson(`data/shelters/${c}.json`))));
  return lists.flat();
}
