// 画面の組み立て。判定は core/judge.js、外部データの取得は services.js が担当する。
// 外部データ(避難場所名・備考など)は必ず textContent で表示し、HTML として解釈させない。

import { STATUS_LABELS, judge } from "./core/judge.js";
import { DEMO_PLACES, DEMO_SCENARIOS, demoWarnings } from "./core/demo.js";
import { describeZone } from "./core/hazardMap.js";
import { SNAPSHOT_KEY, describeAge, makeSnapshot, parseSnapshot } from "./core/snapshot.js";
import {
  DESIGNATION_LABELS,
  coverageNotice,
  formatDistance,
  mesh2Code,
  municipalityName,
  registeredMuni,
  selectShelters,
} from "./core/shelters.js";
import {
  getCurrentPosition,
  getMunicipality,
  getSheltersAround,
  getWarnings,
  getZones,
  loadShelterIndex,
  requestExplanation,
} from "./services.js";

// 避難が不要な判定のときに「参考」として出す避難場所(大雨に関係する種別のどれか)
const REFERENCE_REQUIREMENT = [["flood", "inland_flood", "landslide", "storm_surge"]];

const $ = (id) => document.getElementById(id);

/** 要素を作る。文字は textContent で入れる */
function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---- 地図 ----

let map;
let markers;
let floodOverlay;

function ensureMap() {
  if (map) return;
  const L = window.L;
  map = L.map("map", { scrollWheelZoom: false });
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
  }).addTo(map);
  floodOverlay = L.tileLayer("https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png", {
    maxZoom: 18,
    maxNativeZoom: 17,
    opacity: 0.55,
    attribution: '<a href="https://disaportal.gsi.go.jp/" target="_blank" rel="noopener">ハザードマップポータルサイト</a>',
  });
  markers = L.layerGroup().addTo(map);
  $("overlay").addEventListener("change", (e) => (e.target.checked ? floodOverlay.addTo(map) : floodOverlay.remove()));
}

function renderMap(origin, shelters) {
  ensureMap();
  const L = window.L;
  markers.clearLayers();
  L.circleMarker([origin.lat, origin.lon], { radius: 9, color: "#fff", weight: 3, fillColor: "#1565c0", fillOpacity: 1 })
    .bindTooltip("現在地", { permanent: false })
    .addTo(markers);
  shelters.forEach((s, i) => {
    const icon = L.divIcon({ className: "shelter-pin", html: String(i + 1), iconSize: [30, 30], iconAnchor: [15, 15] });
    L.marker([s.lat, s.lon], { icon, title: s.name }).bindPopup(el("strong", { text: s.name })).addTo(markers);
  });
  const points = [[origin.lat, origin.lon], ...shelters.map((s) => [s.lat, s.lon])];
  if (points.length > 1) map.fitBounds(points, { padding: [36, 36], maxZoom: 16 });
  else map.setView(points[0], 15);
  // 非表示から表示に切り替えた直後は大きさを測り直す
  setTimeout(() => map.invalidateSize(), 0);
}

// ---- 表示 ----

function renderWarnings(result, meta) {
  const list = $("warnings");
  list.replaceChildren();
  const active = result.hazards.filter((h) => h.warningName);
  if (meta.warningsUnknown) {
    list.append(el("li", { text: "警報:取得できませんでした" }));
  } else if (active.length === 0) {
    list.append(el("li", { text: "大雨・土砂災害・高潮の警報・注意報:発表なし" }));
  } else {
    for (const h of active) list.append(el("li", { text: h.warningName }));
  }
  $("source-time").textContent = meta.demo
    ? "デモ用の仮の警報です"
    : meta.reportDatetime
      ? `気象庁 ${formatTime(meta.reportDatetime)} 発表の情報`
      : "";
}

function renderNotices(result, coverage) {
  const box = $("notices");
  box.replaceChildren();
  const items = [...(coverage ? [{ text: coverage.text, url: coverage.link.url, label: coverage.link.label }] : [])];
  for (const n of result.notices) items.push({ text: n.text, url: n.url, label: "川の防災情報" });
  for (const n of items) {
    box.append(
      el("div", { className: "notice", attrs: { role: "note" } }, [
        el("p", { text: n.text }),
        el("a", { text: `${n.label} を開く`, attrs: { href: n.url, target: "_blank", rel: "noopener" } }),
      ]),
    );
  }
}

function renderShelters(result, shelters, origin, muni, municipalities) {
  const needs = result.shelterRequirements.length > 0;
  $("shelters-title").textContent = needs ? "避難場所(近い順)" : "参考:近くの指定緊急避難場所";
  $("shelters-help").textContent = needs
    ? `この災害(${result.hazards.filter((h) => h.status === result.status).map((h) => h.label).join("・")})に対応して指定された避難場所です。距離は直線距離です。`
    : "今は避難の必要はありません。いざというときのために、近くの避難場所を確認しておきましょう。";

  const list = $("shelters");
  list.replaceChildren();
  if (shelters.length === 0) {
    list.append(
      el("li", {
        className: "shelter-empty",
        text: "近くに条件に合う避難場所がデータ上見つかりませんでした。区市町村のハザードマップと避難情報を確認してください。",
      }),
    );
  }
  // 政令指定都市は区ではなく市の単位で比べる(避難場所データが市の単位のため)
  const here = registeredMuni(municipalities, muni);
  shelters.forEach((s, i) => {
    const otherMuni = here && s.muni !== here ? municipalityName(municipalities, s.muni) : null;
    const designations = s.hazards.map((h) => DESIGNATION_LABELS[h] ?? h).join("・");
    list.append(
      el("li", { className: `shelter-card${s.conditional ? " is-conditional" : ""}`, attrs: { "data-shelter-id": s.id } }, [
        el("div", { className: "shelter-head" }, [
          el("span", { className: "pin", text: String(i + 1), attrs: { "aria-hidden": "true" } }),
          el("strong", { className: "shelter-name", text: s.name }),
          el("span", { className: "distance", text: formatDistance(s.distanceM) }),
        ]),
        otherMuni ? el("p", { className: "tag-other", text: `${otherMuni}の避難場所` }) : null,
        el("p", { className: "address", text: s.address }),
        el("p", { className: "designations", text: `指定されている災害:${designations}` }),
        s.note
          ? el("p", { className: s.conditional ? "note warn" : "note", text: `${s.conditional ? "注意 " : ""}備考:${s.note}` })
          : null,
        el("a", {
          className: "route",
          text: "Google マップで徒歩ルートを開く",
          attrs: { href: s.routeUrl, target: "_blank", rel: "noopener" },
        }),
      ]),
    );
  });
  renderMap(origin, shelters);
}

function renderBreakdown(result) {
  const body = $("breakdown");
  body.replaceChildren();
  for (const h of result.hazards) {
    body.append(
      el("tr", {}, [
        el("th", { text: h.label, attrs: { scope: "row" } }),
        el("td", { text: h.level == null ? "取得できず" : h.warningName ?? "発表なし" }),
        el("td", { text: describeZone(h.zone) }),
        el("td", { text: STATUS_LABELS[h.status] }),
      ]),
    );
  }
}

function render({ result, origin, shelters, coverage, muni, municipalities, meta }) {
  const card = $("status-card");
  card.dataset.status = result.status;
  $("status-label").textContent = `判定:${STATUS_LABELS[result.status]}`;
  $("headline").textContent = result.headline;
  $("actions").replaceChildren(...result.actions.map((a) => el("li", { text: a })));
  renderWarnings(result, meta);
  renderNotices(result, coverage);
  $("disclaimer").textContent = result.disclaimer;
  renderBreakdown(result);
  $("result").hidden = false;
  renderShelters(result, shelters, origin, muni, municipalities);
  $("headline").focus();
}

// ---- AI による補足 ----
// 判定・避難場所の表示が終わってから、裏で取りに行く。失敗しても判定の表示には影響しない。

let explainSeq = 0;

function renderAi(state, res = null, status = null) {
  const box = $("ai-box");
  const summary = $("ai-summary");
  const advice = $("ai-advice");
  const note = $("ai-status");
  document.querySelectorAll(".ai-comment").forEach((n) => n.remove());
  summary.replaceChildren();
  advice.replaceChildren();

  // サーバーに APIキーが設定されていない(AI を使わない構成)なら、欄ごと出さない
  if (state === "done" && res?.reason === "not-configured") {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.toggle("is-loading", state === "loading");
  if (state === "loading") {
    note.textContent = "AIが説明を作成しています…";
    return;
  }
  // 古い判定に対する説明は使わない(判定が一致するものだけ表示する)
  if (!res?.ok || res.status !== status) {
    note.textContent = "AIの補足は表示できませんでした(判定と避難場所の案内には影響しません)。";
    return;
  }
  summary.textContent = res.summary;
  advice.replaceChildren(...res.advice.map((a) => el("li", { text: a })));
  for (const s of res.shelters) {
    const card = document.querySelector(`[data-shelter-id="${CSS.escape(s.id)}"]`);
    card?.querySelector(".route")?.before(el("p", { className: "ai-comment", text: `AI:${s.comment}` }));
  }
  note.textContent = "";
}

function explain({ warnings, zones, shelters, muni, demo, status }) {
  const seq = ++explainSeq;
  renderAi("loading");
  const payload = {
    // 送るのは警報レベル・区域の判定・避難場所の ID だけ。正確な現在地は送らない
    warnings: warnings ? Object.fromEntries(Object.entries(warnings).map(([h, w]) => [h, w.level])) : null,
    zones,
    shelters: shelters.map((s) => ({ id: s.id, mesh: mesh2Code(s.lat, s.lon), distanceM: s.distanceM })),
    muni,
    demo,
  };
  requestExplanation(payload).then((res) => {
    if (seq === explainSeq) renderAi("done", res, status);
  });
}

// ---- 前回の結果(オフラインのときに表示する) ----
// この端末のブラウザにだけ保存する。保存できない環境(プライベートモードなど)でも判定には影響しない。

function loadSnapshot() {
  try {
    return parseSnapshot(localStorage.getItem(SNAPSHOT_KEY));
  } catch {
    return null;
  }
}

function saveSnapshot(snapshot) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // 保存できなくても、判定の表示には影響しない
  }
  updateSavedNote();
}

function clearSnapshot() {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // 消せない環境では何もしない
  }
  updateSavedNote();
}

function updateSavedNote() {
  const snap = loadSnapshot();
  $("saved-note").textContent = snap
    ? `この端末に保存している結果:${formatTime(snap.savedAt)}に確認したもの`
    : "この端末に保存している結果はありません。";
  $("clear-saved").hidden = !snap;
}

/** 保存してある前回の結果を、理由と確認した時刻を添えて表示する。なければ false */
function showSnapshot(reason) {
  const snap = loadSnapshot();
  if (!snap) return false;
  explainSeq++; // 進んでいる AI の説明は使わない
  $("ai-box").hidden = true;
  $("demo-banner").hidden = true;
  render({
    result: snap.result,
    origin: snap.origin,
    shelters: snap.shelters,
    coverage: snap.coverage,
    muni: snap.muni,
    municipalities: snap.municipalities,
    meta: { demo: false, ...snap.meta },
  });
  $("snapshot-text").textContent =
    `${reason}。${formatTime(snap.savedAt)}(${describeAge(snap.savedAt)})に確認した結果を表示しています。` +
    "最新の警報ではありません。避難場所までの距離は、そのときに確認した地点からのものです。";
  $("snapshot-banner").hidden = false;
  return true;
}

// ---- 実行 ----

function setProgress(text, isError = false) {
  const p = $("progress");
  p.textContent = text;
  p.classList.toggle("is-error", isError);
}

let running = false;

async function run(origin, demoScenario = null) {
  if (running) return;
  if (!navigator.onLine) {
    if (showSnapshot("オフラインのため、新しい判定はできません")) setProgress("");
    else setProgress("オフラインのため判定できません。通信できる場所で、もう一度試してください。", true);
    return;
  }
  running = true;
  document.body.classList.add("is-busy");
  setProgress("危険区域・警報・避難場所を調べています…");
  try {
    const [muni, zones, index, around] = await Promise.all([
      getMunicipality(origin),
      getZones(origin),
      loadShelterIndex().catch(() => null),
      getSheltersAround(origin).catch(() => []),
    ]);
    // 住所検索も危険区域も1つも取れなければ、通信できていないとみなし、前回の結果があればそれを出す
    const unreachable = muni === null && Object.values(zones).every((z) => z.state === "unknown");
    if (unreachable && !demoScenario && showSnapshot("通信できないため、新しい判定ができませんでした")) {
      setProgress("");
      return;
    }
    const live = demoScenario ? null : await getWarnings(muni);
    const warnings = demoScenario ? demoWarnings(demoScenario) : (live?.levels ?? null);
    const result = judge({ warnings, zones });
    const requirements = result.shelterRequirements.length > 0 ? result.shelterRequirements : REFERENCE_REQUIREMENT;
    const shelters = selectShelters(around, origin, requirements, 3);
    const coverage = coverageNotice(index?.municipalities, muni, result.shelterRequirements);
    const meta = { demo: Boolean(demoScenario), reportDatetime: live?.reportDatetime, warningsUnknown: warnings === null };
    $("demo-banner").hidden = !demoScenario;
    $("snapshot-banner").hidden = true;
    render({ result, origin, shelters, coverage, muni, municipalities: index?.municipalities, meta });
    setProgress("");
    // デモの結果と、通信できずに判定できなかった結果は保存しない
    if (!demoScenario && !unreachable) {
      saveSnapshot(makeSnapshot({ result, origin, shelters, coverage, muni, municipalities: index?.municipalities, meta }));
    }
    explain({ warnings, zones, shelters, muni, demo: Boolean(demoScenario), status: result.status });
  } catch (e) {
    setProgress(`判定中にエラーが起きました:${e.message}`, true);
  } finally {
    running = false;
    document.body.classList.remove("is-busy");
  }
}

async function runHere() {
  setProgress("現在地を取得しています…");
  try {
    await run(await getCurrentPosition());
  } catch (e) {
    setProgress(e.message, true);
  }
}

function runDemo() {
  const place = DEMO_PLACES.find((p) => p.id === $("demo-place").value);
  run({ lat: place.lat, lon: place.lon }, $("demo-scenario").value);
}

async function renderSources() {
  try {
    const index = await loadShelterIndex();
    $("gsi-notice").replaceChildren(...index.notice.map((n) => el("li", { text: n })));
  } catch {
    // 出典の表示は判定に影響しないので、失敗しても止めない
  }
}

function init() {
  $("demo-place").replaceChildren(...DEMO_PLACES.map((p) => el("option", { text: p.label, attrs: { value: p.id } })));
  $("demo-scenario").replaceChildren(...DEMO_SCENARIOS.map((s) => el("option", { text: s.label, attrs: { value: s.id } })));
  $("demo-scenario").value = "rain4";
  $("locate").addEventListener("click", runHere);
  $("demo-run").addEventListener("click", runDemo);
  $("clear-saved").addEventListener("click", clearSnapshot);
  renderSources();
  updateSavedNote();

  // 通信できないときも開けるようにする(登録できない環境でも、通信できれば普通に使える)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  const updateOnline = () => {
    $("offline-banner").hidden = navigator.onLine;
  };
  addEventListener("online", updateOnline);
  addEventListener("offline", updateOnline);
  updateOnline();

  // デモの URL(?demo=場所&scenario=警報)を開くと、そのデモをすぐ表示する。ポートフォリオで共有する用
  const params = new URLSearchParams(location.search);
  const place = DEMO_PLACES.find((p) => p.id === params.get("demo"));
  const scenario = DEMO_SCENARIOS.find((s) => s.id === params.get("scenario"));
  if (place && scenario) {
    $("demo-place").value = place.id;
    $("demo-scenario").value = scenario.id;
    document.querySelector("details.demo").open = true;
    runDemo();
  } else if (!navigator.onLine) {
    // オフラインで開いたときは、前回の結果をすぐ出す
    showSnapshot("オフラインのため、新しい判定はできません");
  }
}

init();
