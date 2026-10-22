// POST /api/explain  判定の理由と行動のアドバイスを AI(Gemini)に書かせる。
//
// 安全のための設計:
// - ブラウザから受け取るのは、警報レベル(数字)・区域の判定(決まった選択肢)・避難場所の ID だけ。
//   自由な文章は受け取らないので、AI に好きな指示を送り込むことはできない。
// - 判定はここで同じルール(core/judge.js)を使って計算し直す。避難場所の名前や備考は、
//   公開しているデータから ID で引き直す。AI に渡すのは、こうして作り直した事実データだけ。
// - 正確な現在地(緯度経度・住所)は AI に送らない。
// - AI の出力は aiGuard.js で検証し、判定と矛盾する・データにない数字や避難場所がある場合は捨てる。

import { HAZARDS, WARNING_CODES } from "../web/src/core/jma.js";
import { DEPTH_MINS, describeZone, depthLabelFor } from "../web/src/core/hazardMap.js";
import { STATUS_LABELS, judge } from "../web/src/core/judge.js";
import { DESIGNATION_LABELS, coverageNotice, formatDistance, municipalityName } from "../web/src/core/shelters.js";
import { checkAiOutput, levelsIn, quantitiesIn } from "./aiGuard.js";
import { DEFAULT_MODEL, generateJson } from "./gemini.js";

const MAX_BODY = 4096;
const ZONE_KEYS = ["flood", "inland", "stormSurge", "sediment", "houseCollapse"];

export const SYSTEM_INSTRUCTION = `あなたは防災アプリ「DASHELTER」の説明係です。
避難の判定は、気象庁の警報とハザードマップにもとづくルールですでに決まっています。
画面には、判定・見出し・「アプリが示している行動」がすでに表示されています。
あなたの役割は、その表示を補う短い説明を書くことです。画面の文を繰り返すだけの説明は不要です。

出力(JSON):
- summary: なぜこの判定になったのかを、事実データ(警報の名前、今いる場所が危険区域の中か外か、浸水の深さなど)を根拠に説明する。見出しの言い換えだけにしない。100字以内。
- advice: 「アプリが示している行動」に書かれていない、補足の行動を1〜3個。判定に合った一般的な防災の知識を使ってよい。
  例: 避難するなら、動きやすい靴、両手が空くかばん、懐中電灯、家族への連絡、明るいうちの移動。
      とどまるなら、停電や断水への備え、テレビ・ラジオ・自治体の情報の確認、家族の安否確認。
  「アプリが示している行動」と同じ内容は書かない。それぞれ60字以内。
- shelters: 避難場所ごとの一言。利用者が知っておくべき点があるときだけ書く。
  例: 備考に開設の条件がある、今いる区市町村とは別の区市町村にある、備考に書かれた注意。
  名前や距離を言い直すだけになる場合は、その避難場所は含めない(空の配列でもよい)。60字以内。

必ず守ること:
- 判定を変えたり、弱めたり、強めたりしない。「安全です」「心配ありません」のような安全の保証もしない。
- 数字(距離、浸水の深さ、警報レベル、時間など)は、事実データに書かれているものだけを使う。新しい数字を作らない(「徒歩10分」なども書かない)。
- 特定の場所や建物について、事実データにないこと(設備、混雑、標高、道順など)は書かない。今後の天気の予想も書かない。
- 避難場所に触れるときは、事実データにある id の避難場所だけを使う。
- やさしい日本語で、短く書く。URL や記号の装飾は使わない。`;

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "判定の理由の説明(100字以内)" },
    advice: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "画面の行動を補う、行動のアドバイス" },
    shelters: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, comment: { type: "string" } },
        required: ["id", "comment"],
      },
    },
  },
  required: ["summary", "advice", "shelters"],
};

class BadRequest extends Error {}

const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function parseZone(z) {
  if (z?.state === "out" || z?.state === "unknown") return { state: z.state };
  if (z?.state !== "in") throw new BadRequest("zone");
  const zone = { state: "in" };
  if ("depthMin" in z) {
    if (z.depthMin !== null && !DEPTH_MINS.includes(z.depthMin)) throw new BadRequest("depth");
    zone.depthMin = z.depthMin;
    zone.depthLabel = depthLabelFor(z.depthMin);
  }
  if ("special" in z) {
    if (typeof z.special !== "boolean") throw new BadRequest("special");
    zone.special = z.special;
  }
  return zone;
}

/** ブラウザからの入力を検証し、決まった形に作り直す。自由な文章は受け付けない */
export function parseExplainInput(body) {
  if (!body || typeof body !== "object") throw new BadRequest("body");

  let levels = null;
  if (body.warnings !== null) {
    levels = {};
    for (const hazard of HAZARDS) {
      const level = body.warnings?.[hazard];
      if (!Number.isInteger(level) || level < 0 || level > 5) throw new BadRequest("level");
      levels[hazard] = level;
    }
  }

  const zones = Object.fromEntries(ZONE_KEYS.map((k) => [k, parseZone(body.zones?.[k])]));

  if (!Array.isArray(body.shelters) || body.shelters.length > 3) throw new BadRequest("shelters");
  const shelters = body.shelters.map((s) => {
    // 共通ID は「E + 13桁」。末尾が英字のもの(例: E206020000520A)もある
    if (typeof s?.id !== "string" || !/^[A-Z][0-9A-Z]{13}$/.test(s.id)) throw new BadRequest("shelter id");
    if (typeof s.mesh !== "string" || !/^\d{6}$/.test(s.mesh)) throw new BadRequest("shelter mesh");
    if (!Number.isInteger(s.distanceM) || s.distanceM < 0 || s.distanceM > 100000) throw new BadRequest("distance");
    return { id: s.id, mesh: s.mesh, distanceM: s.distanceM };
  });

  if (body.muni !== null && (typeof body.muni !== "string" || !/^\d{5}$/.test(body.muni))) throw new BadRequest("muni");
  if (typeof body.demo !== "boolean") throw new BadRequest("demo");
  return { levels, zones, shelters, muni: body.muni, demo: body.demo };
}

/** 警報レベル → 本物の警報と同じ形({level, name}) */
function toWarnings(levels, demo) {
  if (!levels) return null;
  return Object.fromEntries(
    HAZARDS.map((hazard) => {
      const level = levels[hazard];
      const def = Object.values(WARNING_CODES).find((d) => d.hazard === hazard && d.level === level);
      const name = def ? `${def.name}${demo ? "(デモ)" : ""}` : null;
      return [hazard, { level, name }];
    }),
  );
}

async function loadJson(assets, base, path) {
  const res = await assets.fetch(new Request(new URL(path, base)));
  if (!res.ok) throw new BadRequest(`asset ${path}`);
  return res.json();
}

/** 避難場所を、公開しているデータから ID で引き直す */
async function lookupShelters(assets, base, requested) {
  const meshes = [...new Set(requested.map((s) => s.mesh))];
  const lists = await Promise.all(meshes.map((m) => loadJson(assets, base, `/data/shelters/${m}.json`)));
  const byId = new Map(lists.flat().map((s) => [s.id, s]));
  return requested.map((r) => {
    const s = byId.get(r.id);
    if (!s) throw new BadRequest("unknown shelter");
    return { ...s, distanceM: r.distanceM };
  });
}

/** AI に渡す事実データ。正確な現在地(緯度経度・住所)は含めない */
export function buildFacts({ result, shelters, municipalities, muni, demo }) {
  const coverage = coverageNotice(municipalities, muni, result.shelterRequirements);
  const needsShelter = ["emergency", "evacuate"].includes(result.status);
  const facts = {
    判定: STATUS_LABELS[result.status],
    // 区市町村の名前まで(住所・緯度経度は送らない)。「別の区の避難場所」の説明に使う
    今いる区市町村: municipalityName(municipalities, muni) ?? "不明",
    画面の見出し: result.headline,
    アプリが示している行動: result.actions,
    災害ごとの状況: result.hazards.map((h) => ({
      災害: h.label,
      警報: h.level == null ? "取得できず" : (h.warningName ?? "発表なし"),
      今いる場所: describeZone(h.zone),
      判定: STATUS_LABELS[h.status],
    })),
    注意: [...result.notices.map((n) => n.text), ...(coverage ? [coverage.text] : [])],
    避難場所: shelters.map((s) => ({
      id: s.id,
      名前: s.name,
      区市町村: municipalityName(municipalities, s.muni) ?? "不明",
      直線距離: formatDistance(s.distanceM),
      指定されている災害: s.hazards.map((h) => DESIGNATION_LABELS[h] ?? h),
      備考: s.note || "なし",
    })),
  };
  if (needsShelter) {
    facts.建物の上の階での安全確保 = {
      allowed: "条件を満たせば選べる",
      "not-allowed": "できない(危険区域の外へ避難が必要)",
      unknown: "判断できる情報がない",
    }[result.verticalEvacuation];
  }
  if (demo) facts.デモ = "これはデモです。警報は仮のデータです";
  return facts;
}

/** AI の出力の検証に使う「事実データに出てくる警報レベル・数量」 */
export function guardContext(result, facts, shelters) {
  const text = JSON.stringify(facts);
  const depthQuantities = result.hazards.flatMap((h) =>
    (h.zone.depthLabel?.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => `${Number(n)}m`),
  );
  return {
    status: result.status,
    levels: levelsIn(text),
    shelterIds: shelters.map((s) => s.id),
    quantities: [...new Set([...quantitiesIn(text), ...depthQuantities])],
  };
}

/**
 * @param {Request} request
 * @param {{GEMINI_API_KEY?: string, GEMINI_MODEL?: string, ASSETS: {fetch: (r: Request) => Promise<Response>}}} env
 */
export async function handleExplain(request, env, { fetchFn = fetch } = {}) {
  if (!env.GEMINI_API_KEY) return json({ ok: false, reason: "not-configured" }, 503);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, reason: "too-large" }, 413);

  let result, shelters, index, input;
  try {
    input = parseExplainInput(JSON.parse(raw));
    result = judge({ warnings: toWarnings(input.levels, input.demo), zones: input.zones });
    [shelters, index] = await Promise.all([
      lookupShelters(env.ASSETS, request.url, input.shelters),
      loadJson(env.ASSETS, request.url, "/data/shelters/index.json"),
    ]);
  } catch (e) {
    if (e instanceof BadRequest || e instanceof SyntaxError) return json({ ok: false, reason: "bad-request" }, 400);
    throw e;
  }

  const facts = buildFacts({ result, shelters, municipalities: index.municipalities, muni: input.muni, demo: input.demo });
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;

  let output;
  try {
    output = await generateJson({
      apiKey: env.GEMINI_API_KEY,
      model,
      systemInstruction: SYSTEM_INSTRUCTION,
      input: `事実データ:\n${JSON.stringify(facts, null, 1)}`,
      schema: OUTPUT_SCHEMA,
      fetchFn,
    });
  } catch (e) {
    console.error("AI の呼び出しに失敗:", e.message);
    return json({ ok: false, reason: e.reason ?? "error" }, 502);
  }

  const checked = checkAiOutput(output, guardContext(result, facts, shelters));
  if (!checked.ok) {
    console.warn("AI の出力を不採用:", checked.reason);
    return json({ ok: false, reason: `rejected:${checked.reason}` }, 502);
  }
  return json({ ok: true, model, status: result.status, ...dropRepeats(checked.value, result, shelters) }, 200);
}

// 句読点・空白・記号を除いて比べる
const normalize = (s) => s.replace(/[\s、。,.!?！？・「」『』()()]/g, "");

/**
 * 検証を通った出力から、画面にすでにある文の繰り返しを取り除く(出力全体は捨てない)。
 * - アドバイス: 「アプリが示している行動」と同じ内容のもの
 * - 避難場所への一言: 名前を言い直すだけ・「備考はありません」だけのもの
 */
export function dropRepeats(value, result, shelters) {
  const actions = result.actions.map(normalize);
  const advice = value.advice.filter((a) => {
    const n = normalize(a);
    return !actions.some((act) => act.includes(n) || n.includes(act));
  });
  const names = new Map(shelters.map((s) => [s.id, normalize(s.name)]));
  const comments = value.shelters.filter((s) => {
    const rest = normalize(s.comment)
      .replace(names.get(s.id) ?? "", "")
      .replace(/備考はありません|備考はなし|です|にあります|の避難場所/g, "");
    return rest.length >= 6;
  });
  return { ...value, advice, shelters: comments };
}
