import { test } from "node:test";
import assert from "node:assert/strict";

import { checkAiOutput, levelsIn, quantitiesIn } from "../worker/aiGuard.js";

const context = {
  status: "evacuate",
  levels: [4],
  shelterIds: ["E1311800000101", "E1311800000102"],
  quantities: ["1.2km", "630m", "3m", "5m"],
};

const good = () => ({
  summary: "レベル4大雨危険警報が出ていて、今いる場所は浸水3〜5mと想定される区域のため、避難が必要と判定されました。",
  advice: ["暗くなる前に移動しましょう", "冠水した道路や地下道は通らないでください"],
  shelters: [{ id: "E1311800000101", comment: "約630mの距離にあり、洪水に対応した避難場所です" }],
});

test("事実データの範囲内の出力は採用する", () => {
  const r = checkAiOutput(good(), context);
  assert.equal(r.ok, true);
  assert.equal(r.value.advice.length, 2);
});

test("形が違う・長すぎる出力は不採用", () => {
  assert.deepEqual(checkAiOutput(null, context), { ok: false, reason: "not-object" });
  assert.equal(checkAiOutput({ ...good(), summary: "" }, context).reason, "summary");
  assert.equal(checkAiOutput({ ...good(), summary: "あ".repeat(200) }, context).reason, "summary");
  assert.equal(checkAiOutput({ ...good(), advice: [] }, context).reason, "advice");
  assert.equal(checkAiOutput({ ...good(), advice: ["a", "b", "c", "d"] }, context).reason, "advice");
});

test("渡していない避難場所の ID があれば不採用", () => {
  const out = { ...good(), shelters: [{ id: "E9999999999999", comment: "近くです" }] };
  assert.equal(checkAiOutput(out, context).reason, "unknown-shelter");
});

test("判定と矛盾する言い方があれば不採用(避難の判定で「安全です」など)", () => {
  for (const text of ["この場所は安全です", "避難の必要はありません", "今いる場所にとどまってください", "しばらく様子を見ましょう"]) {
    assert.equal(checkAiOutput({ ...good(), advice: [text] }, context).reason, "contradiction", text);
  }
});

test("とどまる判定で「今すぐ避難」と言えば不採用", () => {
  const stay = { ...context, status: "stay", shelterIds: [] };
  assert.equal(checkAiOutput({ ...good(), shelters: [], advice: ["今すぐ避難してください"] }, stay).reason, "contradiction");
  assert.equal(checkAiOutput({ ...good(), summary: "危険区域の外なので、外出を控えましょう", shelters: [] }, stay).ok, true);
});

test("どの判定でも、安全を保証する言い方は不採用", () => {
  const safe = { ...context, status: "safe", levels: [] };
  const out = { summary: "警報は出ていません", advice: ["絶対に安全なので心配ありません"], shelters: [] };
  assert.equal(checkAiOutput(out, safe).reason, "contradiction");
});

test("発表されていない警報レベルを書けば不採用", () => {
  assert.equal(checkAiOutput({ ...good(), summary: "レベル5の特別警報が出ています" }, context).reason, "unknown-level");
  // 全角数字も同じように扱う
  assert.equal(checkAiOutput({ ...good(), summary: "レベル５の特別警報が出ています" }, context).reason, "unknown-level");
});

test("事実データにない距離・深さ・時間を書けば不採用", () => {
  for (const text of ["徒歩約10分です", "浸水は2mの想定です", "約2kmの距離です", "1時間に50mmの雨"]) {
    assert.equal(checkAiOutput({ ...good(), advice: [text] }, context).reason, "unknown-number", text);
  }
  // 全角で書いてもすり抜けない
  assert.equal(checkAiOutput({ ...good(), advice: ["浸水は２ｍの想定です"] }, context).reason, "unknown-number");
  // データにある数字なら単位の書き方が違っても採用する
  assert.equal(checkAiOutput({ ...good(), advice: ["3メートル以上浸かるおそれがあります"] }, context).ok, true);
});

test("URL や HTML を含めば不採用", () => {
  assert.equal(checkAiOutput({ ...good(), summary: "詳しくは https://example.com を見てください" }, context).reason, "markup");
  assert.equal(checkAiOutput({ ...good(), summary: "<b>避難</b>してください" }, context).reason, "markup");
});

test("数量と警報レベルの読み取り", () => {
  assert.deepEqual(quantitiesIn("約1.2km先、浸水３ｍ、約630メートル、0.5キロ"), ["1.2km", "3m", "630m", "0.5km"]);
  assert.deepEqual(levelsIn("レベル4大雨危険警報とレベル 3"), [4, 3]);
});
