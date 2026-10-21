import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import worker from "../worker/index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 静的ファイルの配信(本番では Cloudflare が担当)の代わり。呼ばれた URL を記録する */
function fakeAssets() {
  const calls = [];
  return {
    calls,
    env: {
      ASSETS: {
        fetch: async (req) => {
          calls.push(new URL(req.url).pathname);
          return new Response("asset", { status: 200 });
        },
      },
    },
  };
}

const get = (path, init) => new Request(`https://dashelter.example${path}`, init);

test("/api/municipality は Worker が処理し、セキュリティ用のヘッダーを付ける", async () => {
  globalThis.fetch = async () => Response.json({ results: { muniCd: "13117" } });
  const { env, calls } = fakeAssets();
  const res = await worker.fetch(get("/api/municipality?lat=35.75&lon=139.73"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { muniCd: "13117" });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.deepEqual(calls, []);
});

test("GET 以外は 405", async () => {
  const { env } = fakeAssets();
  const res = await worker.fetch(get("/api/municipality?lat=35.75&lon=139.73", { method: "POST" }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
});

test("存在しない API は 404(静的ファイルには回さない)", async () => {
  const { env, calls } = fakeAssets();
  const res = await worker.fetch(get("/api/unknown"), env);
  assert.equal(res.status, 404);
  assert.deepEqual(calls, []);
});

test("API 以外は静的ファイルの配信に任せる", async () => {
  const { env, calls } = fakeAssets();
  const res = await worker.fetch(get("/no-such-page"), env);
  assert.equal(await res.text(), "asset");
  assert.deepEqual(calls, ["/no-such-page"]);
});
