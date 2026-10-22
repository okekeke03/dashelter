// AI の出力を検証する。1つでも引っかかれば出力全体を捨てる(画面には AI の説明を出さない)。
//
// AI が判定を変えたり、事実データにない数字・避難場所を作ったりしていないかを、
// プログラムで機械的に確かめる。判定と避難場所の案内は AI と関係なく表示されるので、
// 捨てても利用者が困ることはない。

const LIMITS = { summary: 160, advice: 100, adviceCount: 3, comment: 100 };

// どの判定でも使ってはいけない、安全を保証する言い方
const ALWAYS_FORBIDDEN = [/絶対(に)?安全/, /必ず安全/, /心配(は|い)(いりません|ない|ありません)/, /問題ありません/];

// 判定ごとに、判定と矛盾する言い方
const FORBIDDEN_BY_STATUS = {
  emergency: [/安全です/, /避難(の必要|は不要|しなくて)/, /様子を見/],
  evacuate: [/安全です/, /避難(の必要|は不要|しなくて)/, /とどまって/, /移動せず/, /様子を見/],
  prepare: [/安全です/, /避難(の必要|は不要|しなくて)/],
  unknown: [/安全です/, /避難(の必要|は不要|しなくて)/, /今すぐ避難/, /直ちに避難/],
  stay: [/今すぐ避難/, /直ちに避難/, /避難が必要です/, /避難を始め/],
  caution: [/今すぐ避難/, /直ちに避難/, /避難が必要です/, /避難を始め/],
  safe: [/今すぐ避難/, /直ちに避難/, /避難が必要です/, /避難を始め/],
};

const MARKUP = /https?:|<|>|```/;

// 全角の英数字・記号(「３ｍ」「ｋｍ」など)を半角にそろえてから調べる。そろえないと検証をすり抜ける
const toHalfWidth = (s) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 「1.2km」「630m」「3m」のような数量。単位はそろえる */
const QUANTITY = /(\d+(?:\.\d+)?)\s*(km|キロメートル|キロ|mm|ミリ|cm|センチ|m|メートル|時間|分)/g;
const UNIT = { キロメートル: "km", キロ: "km", ミリ: "mm", センチ: "cm", メートル: "m" };

export function quantitiesIn(text) {
  return [...toHalfWidth(text).matchAll(QUANTITY)].map((m) => `${Number(m[1])}${UNIT[m[2]] ?? m[2]}`);
}

export function levelsIn(text) {
  return [...toHalfWidth(text).matchAll(/レベル\s*(\d)/g)].map((m) => Number(m[1]));
}

/**
 * @param {unknown} output AI が返した JSON
 * @param {{status: string, levels: number[], shelterIds: string[], quantities: string[]}} context
 *   levels: 発表中の警報レベル / quantities: 事実データに出てくる数量(「1.2km」「3m」など)
 * @returns {{ok: true, value: {summary: string, advice: string[], shelters: {id: string, comment: string}[]}} | {ok: false, reason: string}}
 */
export function checkAiOutput(output, context) {
  const fail = (reason) => ({ ok: false, reason });
  if (!output || typeof output !== "object") return fail("not-object");
  const { summary, advice, shelters = [] } = output;
  if (typeof summary !== "string" || !summary.trim() || summary.length > LIMITS.summary) return fail("summary");
  if (!Array.isArray(advice) || advice.length < 1 || advice.length > LIMITS.adviceCount) return fail("advice");
  if (advice.some((a) => typeof a !== "string" || !a.trim() || a.length > LIMITS.advice)) return fail("advice");
  if (!Array.isArray(shelters)) return fail("shelters");
  const ids = new Set(context.shelterIds);
  for (const s of shelters) {
    if (!s || typeof s.id !== "string" || typeof s.comment !== "string") return fail("shelters");
    if (!ids.has(s.id)) return fail("unknown-shelter");
    if (!s.comment.trim() || s.comment.length > LIMITS.comment) return fail("shelters");
  }

  const texts = [summary, ...advice, ...shelters.map((s) => s.comment)];
  const forbidden = [...ALWAYS_FORBIDDEN, ...(FORBIDDEN_BY_STATUS[context.status] ?? [])];
  const allowedLevels = new Set(context.levels);
  const allowedQuantities = new Set(context.quantities);
  for (const text of texts) {
    if (MARKUP.test(text)) return fail("markup");
    if (forbidden.some((re) => re.test(text))) return fail("contradiction");
    if (levelsIn(text).some((l) => !allowedLevels.has(l))) return fail("unknown-level");
    if (quantitiesIn(text).some((q) => !allowedQuantities.has(q))) return fail("unknown-number");
  }

  return {
    ok: true,
    value: {
      summary: summary.trim(),
      advice: advice.map((a) => a.trim()),
      shelters: shelters.map((s) => ({ id: s.id, comment: s.comment.trim() })),
    },
  };
}
