// 最後に確認した結果(オフラインのときに表示するため、この端末のブラウザにだけ保存する)。
// 保存した内容は端末の中で書き換えられる可能性もあるので、読み込むときに形を確かめ、
// おかしければ使わない(表示は textContent で行うので、HTML として解釈されることはない)。

import { STATUS_ORDER } from "./judge.js";
import { registeredMuni } from "./shelters.js";

export const SNAPSHOT_KEY = "dashelter:last-result";
export const SNAPSHOT_VERSION = 1;

const SHELTER_FIELDS = ["id", "muni", "name", "address", "lat", "lon", "hazards", "note", "distanceM", "conditional", "routeUrl"];

/**
 * 判定の結果を、保存用の形にする。デモの結果は保存しない(呼び出し側で判断する)。
 * 区市町村の情報は、表示に使うもの(現在地と避難場所の区市町村)だけを残す。
 */
export function makeSnapshot({ result, origin, shelters, coverage, muni, municipalities, meta, savedAt = new Date() }) {
  const codes = new Set([registeredMuni(municipalities, muni), ...shelters.map((s) => s.muni)].filter(Boolean));
  const names = Object.fromEntries([...codes].filter((c) => municipalities?.[c]).map((c) => [c, { name: municipalities[c].name }]));
  return {
    v: SNAPSHOT_VERSION,
    savedAt: savedAt.toISOString(),
    origin: { lat: origin.lat, lon: origin.lon },
    muni,
    result,
    shelters: shelters.map((s) => Object.fromEntries(SHELTER_FIELDS.map((k) => [k, s[k]]))),
    coverage,
    municipalities: names,
    meta: { reportDatetime: meta.reportDatetime ?? null, warningsUnknown: Boolean(meta.warningsUnknown) },
  };
}

const isText = (v) => typeof v === "string";
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** 保存した文字列を読む。形がおかしい・古い形式なら null */
export function parseSnapshot(text) {
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return null;
  }
  if (!s || s.v !== SNAPSHOT_VERSION || !isText(s.savedAt) || Number.isNaN(Date.parse(s.savedAt))) return null;
  if (!isNumber(s.origin?.lat) || !isNumber(s.origin?.lon)) return null;
  const r = s.result;
  if (!r || !STATUS_ORDER.includes(r.status) || !isText(r.headline) || !isText(r.disclaimer)) return null;
  if (![r.actions, r.hazards, r.notices, r.shelterRequirements].every(Array.isArray)) return null;
  if (!r.actions.every(isText)) return null;
  if (!Array.isArray(s.shelters)) return null;
  for (const sh of s.shelters) {
    if (!isText(sh?.id) || !isText(sh.name) || !isNumber(sh.lat) || !isNumber(sh.lon) || !isNumber(sh.distanceM)) return null;
    if (!Array.isArray(sh.hazards) || !isText(sh.routeUrl) || !sh.routeUrl.startsWith("https://www.google.com/maps/")) return null;
  }
  return s;
}

/** 保存してからの経過を「3時間前」のように表す */
export function describeAge(savedAt, now = new Date()) {
  const minutes = Math.max(0, Math.round((now - new Date(savedAt)) / 60000));
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.round(hours / 24)}日前`;
}
