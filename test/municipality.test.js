import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { onRequestGet } from "../functions/api/municipality.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (query) => onRequestGet({ request: new Request(`https://example.test/api/municipality?${query}`) });

test("市町村コードを返す", async () => {
  let requested;
  globalThis.fetch = async (url) => {
    requested = url;
    return Response.json({ results: { muniCd: "13117", lv01Nm: "王子二丁目" } });
  };
  const res = await call("lat=35.7583571&lon=139.7362334");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { muniCd: "13117" });
  // 位置は小数第5位に丸めて送る
  assert.match(requested, /lat=35\.75836&lon=139\.73623$/);
});

test("先頭の 0 が落ちた市町村コードは 5 桁にそろえる", async () => {
  globalThis.fetch = async () => Response.json({ results: { muniCd: "1101" } });
  assert.deepEqual(await (await call("lat=43.06&lon=141.35")).json(), { muniCd: "01101" });
});

test("日本の範囲外・不正な値は 400 で、外部には問い合わせない", async () => {
  globalThis.fetch = async () => assert.fail("呼ばれてはいけない");
  for (const q of ["lat=0&lon=0", "lat=abc&lon=139", "lon=139.7", "lat=35.7&lon=200"]) {
    assert.equal((await call(q)).status, 400, q);
  }
});

test("住所検索が失敗・応答が不正なら、エラーを返す", async () => {
  globalThis.fetch = async () => new Response("", { status: 503 });
  assert.equal((await call("lat=35.7&lon=139.7")).status, 502);
  globalThis.fetch = async () => {
    throw new TypeError("network");
  };
  assert.equal((await call("lat=35.7&lon=139.7")).status, 502);
  globalThis.fetch = async () => Response.json({ results: { muniCd: "" } });
  assert.equal((await call("lat=35.7&lon=139.7")).status, 404);
});
