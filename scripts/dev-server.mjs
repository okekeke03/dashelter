// 手元で動かすための開発用サーバー(Node.js 標準機能のみ)。本番(Cloudflare Workers)と同じ動きをまねる。
// - web/ を静的ファイルとして配信し、web/_headers のヘッダー(CSP など)を付ける
// - /api/* は worker/index.js をそのまま呼び出す(ヘッダーは Worker が付ける)
// - .dev.vars(GEMINI_API_KEY=... など)があれば、Worker の環境変数として渡す。値は表示しない
//
// 使い方(リポジトリのルートで): node scripts/dev-server.mjs  → http://localhost:8788

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

import worker from "../worker/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const PORT = Number(process.env.PORT ?? 8788);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** web/_headers の「/*」に書かれたヘッダーを読む(このプロジェクトで使う書き方だけに対応) */
async function loadHeaders() {
  try {
    const lines = (await readFile(join(WEB, "_headers"), "utf-8")).split(/\r?\n/);
    return Object.fromEntries(
      lines
        .filter((l) => /^\s+\S+:/.test(l))
        .map((l) => {
          const i = l.indexOf(":");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

/** .dev.vars(KEY=VALUE の行)を読む。なければ空 */
async function loadDevVars() {
  try {
    const text = await readFile(join(ROOT, ".dev.vars"), "utf-8");
    const vars = {};
    for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
    return vars;
  } catch {
    return {};
  }
}

/** web/ の静的ファイルを返す(本番では Cloudflare の静的アセット配信が担当) */
async function serveStatic(pathname) {
  let path = resolve(WEB, "." + decodeURIComponent(pathname));
  if (path !== WEB && !path.startsWith(WEB + sep)) return new Response("forbidden", { status: 403 });
  if (pathname.endsWith("/")) path = join(path, "index.html");
  if (path.split(sep).some((part) => part.startsWith("_"))) return new Response("not found", { status: 404 });
  try {
    const body = await readFile(path);
    return new Response(body, {
      headers: { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" },
    });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") return new Response("not found", { status: 404 });
    throw e;
  }
}

const securityHeaders = await loadHeaders();
const devVars = await loadDevVars();
const env = {
  ...devVars,
  ASSETS: { fetch: async (req) => serveStatic(new URL(req.url).pathname) },
};

async function send(res, response, extraHeaders = {}) {
  res.writeHead(response.status, { ...extraHeaders, ...Object.fromEntries(response.headers) });
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const headers = req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {};
      const request = new Request(`http://localhost${req.url}`, { method: req.method, headers, body });
      return await send(res, await worker.fetch(request, env));
    }
    await send(res, await serveStatic(url.pathname), securityHeaders);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("internal error");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`DASHELTER 開発サーバー: http://localhost:${PORT}`);
  console.log(`AI(Gemini): ${devVars.GEMINI_API_KEY ? "APIキーあり(.dev.vars)" : "APIキーなし(AI の補足は表示されません)"}`);
});
