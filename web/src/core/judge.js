// 避難判断のルール。
//
// 考え方(内閣府「避難情報に関するガイドライン」にそろえる):
//   「避難」とは危険な場所から離れること。危険な区域の外にいる人は、避難所へ行く必要はない。
//   現在地の市区町村に出ている警報レベル × 現在地が危険な区域の中か外か で判定する。
//
// AI はこの判定を変えられない。判定結果と事実データを受け取り、説明を作るだけ。

import { HAZARDS, HAZARD_LABELS } from "./jma.js";
import { mergeZones } from "./hazardMap.js";

// 重い順。全体の判定は、災害ごとの判定のうち一番重いもの。
export const STATUS_ORDER = ["emergency", "evacuate", "prepare", "unknown", "stay", "caution", "safe"];

export const STATUS_LABELS = {
  emergency: "緊急安全確保",
  evacuate: "避難",
  prepare: "避難の準備",
  unknown: "判定できない",
  stay: "とどまる",
  caution: "注意",
  safe: "避難は不要",
};

export const HEADLINES = {
  emergency: "命の危険があります。直ちに身の安全を確保してください",
  evacuate: "ここは危険な区域です。今すぐ避難してください",
  prepare: "避難の準備をしてください",
  unknown: "危険かどうかを判定できませんでした",
  stay: "ここは危険区域の外です。移動せず、今いる場所にとどまってください",
  caution: "注意報が出ています。今後の情報に注意してください",
  safe: "現在、避難が必要な状況ではありません",
};

export const DISCLAIMER =
  "この判定は公的機関のデータにもとづく参考情報です。最終的な判断はご自身で行い、自治体の避難指示や周りの状況を優先してください。";

export const RIVER_NOTICE = {
  text: "この場所は、川の氾濫で浸水が想定される区域です。川ごとの氾濫情報は、このアプリでは判定していません。「川の防災情報」(国土交通省)で確認してください。",
  url: "https://www.river.go.jp/",
};

// 災害の種類ごとに、指定緊急避難場所のどの種別が対応するか(どれか1つに指定されていればよい)
export const SHELTER_DESIGNATIONS = {
  rain: ["flood", "inland_flood"],
  landslide: ["landslide"],
  stormSurge: ["storm_surge"],
};

// 浸水深がこれ以上の場所では、建物の上の階への避難(屋内安全確保)を案内しない。2階の床が浸かる目安。
const VERTICAL_LIMIT_M = 3;

const WATER_HAZARDS = new Set(["rain", "stormSurge"]);

/**
 * @typedef {import("./hazardMap.js").Zone} Zone
 * @typedef {{level: number, name: string | null}} Warning
 * @typedef {{
 *   warnings: Record<string, Warning> | null,
 *   zones: {flood: Zone, inland: Zone, stormSurge: Zone, sediment: Zone, houseCollapse: Zone},
 * }} JudgeInput
 */

/** 災害ごとに、どの区域を見るか */
function zoneFor(hazard, zones) {
  if (hazard === "rain") return mergeZones([zones.flood, zones.inland]);
  if (hazard === "landslide") return zones.sediment;
  return zones.stormSurge;
}

/** 1つの災害についての判定(上の表をそのままコードにしたもの) */
export function judgeHazard(warning, zone) {
  if (!warning) return "unknown";
  if (warning.level <= 1) return "safe";
  if (warning.level === 2) return "caution";
  if (zone.state === "out") return "stay";
  if (zone.state === "unknown") return "unknown";
  if (warning.level >= 5) return "emergency";
  if (warning.level === 4) return "evacuate";
  return "prepare";
}

const worse = (a, b) => (STATUS_ORDER.indexOf(a) <= STATUS_ORDER.indexOf(b) ? a : b);

/**
 * 建物の上の階への避難(屋内安全確保)を案内してよいか。水害のときだけ意味がある。
 * @returns {"allowed" | "not-allowed" | "unknown"}
 */
function verticalEvacuation(hazards, zones) {
  const water = hazards.filter((h) => WATER_HAZARDS.has(h.hazard) && h.zone.state === "in");
  if (water.length === 0) return "unknown";
  if (zones.houseCollapse.state === "in") return "not-allowed";
  if (water.some((h) => h.zone.depthMin !== null && h.zone.depthMin >= VERTICAL_LIMIT_M)) return "not-allowed";
  if (zones.houseCollapse.state === "unknown" || water.some((h) => h.zone.depthMin == null)) return "unknown";
  return "allowed";
}

function actionsFor(status, drivers, vertical, zones, warningsKnown) {
  const landslideDriven = drivers.some((h) => h.hazard === "landslide");
  switch (status) {
    case "emergency":
      return [
        "外に出るのが危険な場合は、近くの頑丈な建物の高い階や、崖から離れた部屋に移ってください",
        "すでに安全な場所にいる場合は、そこにとどまってください",
      ];
    case "evacuate": {
      const actions = [
        "下の一覧の避難所へ向かってください",
        "冠水した道路、地下道、アンダーパス、川や水路には近づかないでください",
      ];
      if (landslideDriven) {
        actions.push("土砂災害のおそれがある場所では、建物の上の階ではなく、危険区域の外へ避難してください");
      } else if (vertical === "not-allowed") {
        const reason = zones.houseCollapse.state === "in" ? "家屋が倒壊するおそれのある区域" : "浸水が3m以上と想定される区域";
        actions.push(`ここは${reason}です。建物の上の階ではなく、必ず危険区域の外へ避難してください`);
      } else if (vertical === "allowed") {
        actions.push(
          "浸水が浅いと想定される場所です。浸水しない高さの階にいて、水や食料が十分にあれば、その場にとどまる(屋内安全確保)ことも選べます",
        );
      }
      return actions;
    }
    case "prepare":
      return [
        "持ち出す物、避難先、避難経路を確認してください",
        "高齢の人、障害のある人、小さな子どもがいる人などは、避難を始めてください",
      ];
    case "unknown":
      return [
        warningsKnown
          ? "今いる場所が危険区域かどうかを確認できませんでした。ハザードマップで確認し、危険区域なら避難してください"
          : "警報の情報を取得できませんでした。テレビ・ラジオ・自治体の情報を確認してください",
        "自治体から避難指示が出ている場合は、それに従ってください",
      ];
    case "stay":
      return ["外出は控えてください", "自治体から避難指示が出た場合は、それに従ってください"];
    case "caution":
      return ["今後の気象情報に注意してください"];
    default:
      return ["引き続き、気象情報に注意してください"];
  }
}

/**
 * 避難判断をする。
 * @param {JudgeInput} input
 */
export function judge({ warnings, zones }) {
  const hazards = HAZARDS.map((hazard) => {
    const warning = warnings ? warnings[hazard] : null;
    const zone = zoneFor(hazard, zones);
    return {
      hazard,
      label: HAZARD_LABELS[hazard],
      level: warning ? warning.level : null,
      warningName: warning ? warning.name : null,
      zone,
      status: judgeHazard(warning, zone),
    };
  });

  const status = hazards.map((h) => h.status).reduce(worse, "safe");
  const drivers = hazards.filter((h) => h.status === status);
  const vertical = verticalEvacuation(drivers, zones);

  // 避難所は、準備・避難・緊急のきっかけになった災害に対応したものを探す
  const needsShelter = ["emergency", "evacuate", "prepare"].includes(status);
  const shelterRequirements = needsShelter ? drivers.map((h) => SHELTER_DESIGNATIONS[h.hazard]) : [];

  const notices = [];
  if (zones.flood.state === "in") notices.push(RIVER_NOTICE);

  return {
    status,
    headline: HEADLINES[status],
    actions: actionsFor(status, drivers, vertical, zones, warnings !== null),
    hazards,
    verticalEvacuation: vertical,
    shelterRequirements,
    notices,
    disclaimer: DISCLAIMER,
  };
}
