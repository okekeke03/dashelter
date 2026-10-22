// Cloudflare Workers の入口。
//
// web/ の静的ファイルは Cloudflare が直接配信し(wrangler.jsonc の assets)、ここには来ない。
// ここに来るのは /api/* と、どの静的ファイルにも一致しなかったリクエストだけ。
// web/_headers は静的ファイルにしか効かないので、API の応答にはここでセキュリティ用のヘッダーを付ける。

import { handleMunicipality } from "./municipality.js";
import { handleExplain } from "./explain.js";

// パス → メソッドごとの処理
const ROUTES = {
  "/api/municipality": { GET: (request) => handleMunicipality(request) },
  "/api/explain": { POST: (request, env) => handleExplain(request, env) },
};

const API_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

function withHeaders(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(API_HEADERS)) res.headers.set(k, v);
  return res;
}

export default {
  /**
   * @param {Request} request
   * @param {{ASSETS: {fetch: (req: Request) => Promise<Response>}, GEMINI_API_KEY?: string, GEMINI_MODEL?: string}} env
   */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname];
    if (route) {
      const handler = route[request.method];
      if (!handler) {
        return withHeaders(new Response("Method Not Allowed", { status: 405, headers: { allow: Object.keys(route).join(", ") } }));
      }
      return withHeaders(await handler(request, env));
    }
    if (pathname.startsWith("/api/")) return withHeaders(new Response("Not Found", { status: 404 }));
    return env.ASSETS.fetch(request);
  },
};
