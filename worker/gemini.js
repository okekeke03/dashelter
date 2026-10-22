// Gemini API(Interactions API)の呼び出し。
//   https://ai.google.dev/gemini-api/docs/interactions
// 新規プロジェクトには Interactions API が推奨されている(generateContent は旧方式)。

export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

export class AiError extends Error {
  /** @param {string} reason 画面には出さない、原因の分類(rate-limited など) */
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

/** レスポンスから生成されたテキストを取り出す */
export function extractText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const texts = (data?.steps ?? [])
    .filter((s) => s?.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text);
  if (texts.length === 0) throw new AiError("生成されたテキストがありません", "empty");
  return texts.join("");
}

/**
 * JSON Schema に沿った JSON を生成させる。
 * - store: false … 会話を Google 側に保存しない
 * - thinking_level … Flash-Lite は minimal、Flash は low が最小
 */
export async function generateJson({ apiKey, model = DEFAULT_MODEL, systemInstruction, input, schema, timeoutMs = 10000, fetchFn = fetch }) {
  let res;
  try {
    res = await fetchFn(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model,
        input,
        system_instruction: systemInstruction,
        generation_config: {
          thinking_level: model.includes("flash-lite") ? "minimal" : "low",
          max_output_tokens: 1024,
        },
        response_format: { type: "text", mime_type: "application/json", schema },
        store: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AiError(`Gemini API に接続できませんでした: ${e.message}`, e.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!res.ok) {
    throw new AiError(`Gemini API がエラーを返しました (HTTP ${res.status})`, res.status === 429 ? "rate-limited" : "upstream-error");
  }
  const data = await res.json();
  if (data?.status && data.status !== "completed") {
    throw new AiError(`生成が完了しませんでした (${data.status})`, "incomplete");
  }
  try {
    return JSON.parse(extractText(data));
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError("生成されたテキストが JSON ではありません", "invalid-json");
  }
}
