// DASHELTER の Service Worker。通信できないときも、アプリを開けるようにする。
//
// - 画面のファイル(HTML・JS・CSS・地図ライブラリ)は、最初に開いたときに保存しておく。
// - 見たことのある地域の避難場所データも保存する(最大 MAX_MESH_FILES 地域)。
// - ふだんはネットワークから最新のものを取り、取れないときだけ保存したものを使う(ネットワーク優先)。
//   古い判定ルールや避難場所データを使い続けないため。
// - 警報・ハザードマップ・地図の画像・AI・住所検索は保存しない。古い警報を「今の情報」として使わないため。

const VERSION = "v1";
const SHELL_CACHE = `dashelter-shell-${VERSION}`;
const DATA_CACHE = `dashelter-data-${VERSION}`;
const MAX_MESH_FILES = 60;
const NETWORK_TIMEOUT_MS = 5000;

// 画面に必要なファイル。web/src/ に JS を増やしたら、ここにも足す(テストで確認している)
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "src/app.js",
  "src/services.js",
  "src/core/demo.js",
  "src/core/hazardMap.js",
  "src/core/jma.js",
  "src/core/judge.js",
  "src/core/shelters.js",
  "src/core/snapshot.js",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/leaflet.js",
  "data/jma-areas.json",
  "data/shelters/index.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("dashelter-") && key !== SHELL_CACHE && key !== DATA_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // 外部(気象庁・ハザードマップ・地図の画像)と API は保存しない(ブラウザにそのまま任せる)
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const isMesh = /^\/data\/shelters\/\d{6}\.json$/.test(url.pathname);
  event.respondWith(networkFirst(request, isMesh ? DATA_CACHE : SHELL_CACHE, isMesh));
});

async function networkFirst(request, cacheName, isMesh) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (response.ok) {
      await cache.put(request, response.clone());
      if (isMesh) await trim(cache, MAX_MESH_FILES);
    }
    return response;
  } catch (error) {
    // 「?demo=...」付きで開いた場合も、保存してある画面を返す
    const cached = (await cache.match(request)) ?? (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await caches.match("./", { ignoreSearch: true });
      if (shell) return shell;
    }
    throw error;
  }
}

// ページを開くリクエスト(mode: navigate)には fetch のオプションを付けられないので、
// リクエストはそのまま送り、時間切れだけを外側で判定する
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 古いものから消して、件数を上限以下にする */
async function trim(cache, max) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
}
