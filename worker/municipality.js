// GET /api/municipality?lat=..&lon=..  →  {"muniCd": "13117"}
//
// 国土地理院の住所検索(逆ジオコーダ)の中継。逆ジオコーダは CORS に対応していないため、
// ブラウザから直接は呼べない。

const GSI_URL = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress";

const json = (body, status, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

/** @param {Request} request */
export async function handleMunicipality(request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!params.get("lat") || !params.get("lon") || !(lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154)) {
    return json({ error: "緯度・経度が日本の範囲にありません" }, 400);
  }

  // 位置は約1m単位に丸めてから送る(必要以上に細かい位置を外部に送らない)
  const url = `${GSI_URL}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
  let data;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return json({ error: `住所検索に失敗しました (HTTP ${res.status})` }, 502);
    data = await res.json();
  } catch {
    return json({ error: "住所検索に接続できませんでした" }, 502);
  }

  const muniCd = String(data?.results?.muniCd ?? "");
  if (!/^\d{4,5}$/.test(muniCd)) return json({ error: "区市町村を特定できませんでした" }, 404);
  return json({ muniCd: muniCd.padStart(5, "0") }, 200, { "cache-control": "public, max-age=86400" });
}
