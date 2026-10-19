// 手元で動かすための開発用サーバー(Node.js 標準機能のみ)。
// - web/ を静的ファイルとして配信する
// - /api/* は functions/ の Cloudflare Pages Functions をそのまま呼び出す
// - web/_headers のヘッダー(CSP など)も本番と同じように付ける
//
// 使い方(リポジトリのルートで): node scripts/dev-server.mjs  → http://localhost:8788

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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

async function handleApi(req, res, url) {
  const name = url.pathname.replace(/^\/api\//, "");
  if (!/^[a-z-]+$/.test(name)) return send(res, 404, "not found");
  let mod;
  try {
    mod = await import(pathToFileURL(join(ROOT, "functions", "api", `${name}.js`)).href);
  } catch {
    return send(res, 404, "not found");
  }
  const handler = req.method === "GET" ? mod.onRequestGet : mod.onRequest;
  if (!handler) return send(res, 405, "method not allowed");
  const response = await handler({ request: new Request(`http://localhost${req.url}`, { method: req.method }) });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function send(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

const securityHeaders = await loadHeaders();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    let path = resolve(WEB, "." + decodeURIComponent(url.pathname));
    if (path !== WEB && !path.startsWith(WEB + sep)) return send(res, 403, "forbidden");
    if (url.pathname.endsWith("/")) path = join(path, "index.html");
    if (path.split(sep).some((part) => part.startsWith("_"))) return send(res, 404, "not found");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "EISDIR") return send(res, 404, "not found");
    console.error(e);
    send(res, 500, "internal error");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`DASHELTER 開発サーバー: http://localhost:${PORT}`);
});
