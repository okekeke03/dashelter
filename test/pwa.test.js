// オフライン対応(Service Worker・マニフェスト)の設定が、実際のファイルとずれていないかを確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const WEB = new URL("../web/", import.meta.url);
const sw = readFileSync(new URL("sw.js", WEB), "utf-8");
const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

function jsFiles(dir) {
  return readdirSync(new URL(dir, WEB), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsFiles(`${dir}${e.name}/`) : e.name.endsWith(".js") ? [`${dir}${e.name}`] : [],
  );
}

test("Service Worker が保存するファイルは、すべて実在する", () => {
  for (const path of shell.filter((p) => p !== "./")) {
    assert.ok(existsSync(new URL(path, WEB)), path);
  }
});

test("画面に必要な JS はすべて保存の対象になっている(足し忘れるとオフラインで動かない)", () => {
  for (const file of jsFiles("src/")) assert.ok(shell.includes(file), `${file} が sw.js の SHELL にない`);
  for (const file of ["./", "index.html", "styles.css", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "data/shelters/index.json"]) {
    assert.ok(shell.includes(file), file);
  }
});

test("index.html が読み込むファイルは、すべて保存の対象になっている", () => {
  const html = readFileSync(new URL("index.html", WEB), "utf-8");
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith("http"));
  for (const ref of refs.filter((r) => r !== "icons/apple-touch-icon.png")) assert.ok(shell.includes(ref), ref);
});

test("マニフェスト:ホーム画面に追加するのに必要な項目とアイコンがある", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", WEB), "utf-8"));
  for (const key of ["name", "short_name", "start_url", "display", "icons"]) assert.ok(manifest[key], key);
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"));
  for (const icon of manifest.icons) assert.ok(existsSync(new URL(icon.src, WEB)), icon.src);
});

test("警報・ハザードマップ・API は保存しない(古い警報を今の情報として使わない)", () => {
  assert.match(sw, /url\.origin !== self\.location\.origin \|\| url\.pathname\.startsWith\("\/api\/"\)\) return;/);
});
