// 手元で動かすための開発用サーバー(Node.js 標準機能のみ)。本番(Cloudflare Workers)と同じ動きをまねる。
// - web/ を静的ファイルとして配信し、web/_headers のヘッダー(CSP など)を付ける
// - /api/* は worker/index.js をそのまま呼び出す(ヘッダーは Worker が付ける)
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

// 本番では、静的ファイルに一致しないリクエストは Worker に渡り、Worker が env.ASSETS に任せる。
// 開発用サーバーでは静的ファイルを先に自分で配信するので、ここに来るのは見つからなかった場合だけ。
const env = { ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } };

async function handleApi(req, res) {
  const response = await worker.fetch(new Request(`http://localhost${req.url}`, { method: req.method }), env);
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
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res);
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);

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
