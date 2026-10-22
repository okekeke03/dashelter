"""国土地理院の指定緊急避難場所データを、アプリで使う形に整形する。

- 元データ(CSV)を data/raw/ にダウンロードする(すでにあれば再利用)
- 項目名を英語のキーにそろえ、災害種別のフラグを配列にする
- 座標が欠けている・日本の範囲外にあるデータは除外し、理由を集計する
- 2次メッシュ(約10km四方)ごとに分割して web/data/shelters/ に書き出す
- 前回より件数が大きく減った・除外が多すぎる場合は、壊れたデータとみなして書き出さない

使い方(リポジトリのルートで実行):
    python -I scripts/build_shelters.py            # 全国
    python -I scripts/build_shelters.py 13 14      # 東京都と神奈川県だけ(手元での確認用)
    python -I scripts/build_shelters.py --refresh  # 元データを取り直す
"""

import argparse
import csv
import json
import math
import shutil
import statistics
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "web" / "data" / "shelters"

NATIONAL_URL = "https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/csv/mergeFromCity_2.csv"
PREFECTURE_URL = "https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/csv/{pref:02d}000_2.csv"
SOURCE_PAGE = "https://hinanmap.gsi.go.jp/hinanjocp/hinanbasho/koukaidate.html"
# 市町村ごとの公開状況(「指定避難所データのみ公開」「データ未登録」など)
HISTORY_URL = "https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/publicHistoryCSV/publicHistoryListData.csv"

ALL_PREFS = list(range(1, 48))

# 大雨の判定で使う種別。市町村ごとに件数を数え、データの空白を画面で知らせるのに使う。
RAIN_RELATED = ["flood", "inland_flood", "landslide", "storm_surge"]

# 元データの列名 → アプリで使うキー
HAZARD_COLUMNS = {
    "洪水": "flood",
    "崖崩れ、土石流及び地滑り": "landslide",
    "高潮": "storm_surge",
    "地震": "earthquake",
    "津波": "tsunami",
    "大規模な火事": "fire",
    "内水氾濫": "inland_flood",
    "火山現象": "volcano",
}

# 国土地理院「ご利用上の注意」の要点。第三者に提供する場合は正確に伝えるよう求められているため、
# データと一緒に配布し、画面にも表示する。
NOTICE = [
    "市町村長が指定した指定緊急避難場所を、各市町村が登録したデータです。最新でない場合や未掲載の場合があるため、最新の状況は各市町村に確認してください。",
    "指定緊急避難場所は、災害の種類(洪水・土砂災害・地震など)ごとに指定されています。指定避難所(一定期間滞在するための施設)とは異なります。",
    "データは随時更新されます。",
]

# 日本の範囲(離島を含む)。これを外れる座標は入力ミスとみなす。
JAPAN_BOUNDS = {"lat": (20.0, 46.0), "lon": (122.0, 154.0)}

# 壊れたデータを公開しないための歯止め(自動更新で使う)
MIN_RATIO_TO_PREVIOUS = 0.9  # 前回の件数の 90% を下回ったら止める
MAX_DROP_RATIO = 0.01  # 除外が 1% を超えたら止める

# 同じ市町村の避難場所の中心からこれ以上離れていたら、座標の入力ミスの可能性として報告する(除外はしない)
OUTLIER_KM = 50


def mesh2_code(lat, lon):
    """緯度経度から2次メッシュコード(6桁)を求める。"""
    p, a = divmod(lat * 1.5, 1)
    u = math.floor(lon) - 100
    q = math.floor(a * 8)
    v = math.floor((lon - math.floor(lon)) * 8)
    return f"{int(p):02d}{u:02d}{q}{v}"


def mesh2_bounds(code):
    """2次メッシュコードから範囲 [南, 西, 北, 東] を求める。"""
    p, u, q, v = int(code[0:2]), int(code[2:4]), int(code[4]), int(code[5])
    south = (p + q / 8) / 1.5
    west = 100 + u + v / 8
    return [round(south, 6), round(west, 6), round(south + 1 / 12, 6), round(west + 1 / 8, 6)]


def distance_km(a, b):
    rad = math.radians
    h = math.sin(rad(b[0] - a[0]) / 2) ** 2 + math.cos(rad(a[0])) * math.cos(rad(b[0])) * math.sin(rad(b[1] - a[1]) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def download(url, name, refresh):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DIR / name
    if path.exists() and not refresh:
        return path
    print(f"ダウンロード: {url}")
    tmp = path.with_suffix(path.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as res, open(tmp, "wb") as f:
        shutil.copyfileobj(res, f)
    tmp.replace(path)
    return path


def parse_row(row, dropped, odd_flags):
    """1行を整形する。除外する場合は理由を dropped に数えて None を返す。"""
    shelter_id = (row.get("共通ID") or "").strip()
    name = (row.get("施設・場所名") or "").strip()
    if not shelter_id:
        dropped["共通IDなし"] += 1
        return None
    if not name:
        dropped["名称なし"] += 1
        return None

    try:
        lat = float(row["緯度"])
        lon = float(row["経度"])
    except (KeyError, TypeError, ValueError):
        dropped["座標なし・数値でない"] += 1
        return None
    (lat_min, lat_max), (lon_min, lon_max) = JAPAN_BOUNDS["lat"], JAPAN_BOUNDS["lon"]
    if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
        dropped["座標が日本の範囲外"] += 1
        return None

    hazards = []
    for column, key in HAZARD_COLUMNS.items():
        value = (row.get(column) or "").strip()
        if value == "1":
            hazards.append(key)
        elif value:
            odd_flags[f"{column}={value}"] += 1

    return {
        "id": shelter_id,
        # 共通ID は「E + 市町村コード5桁 + 連番」。政令指定都市は区ではなく市のコード(例: 横浜市 14100)
        "muni": shelter_id[1:6],
        "name": name,
        "address": (row.get("住所") or "").strip(),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "hazards": hazards,
        "alsoShelter": (row.get("指定避難所との住所同一") or "").strip() == "1",
        "note": (row.get("備考") or "").strip(),
    }


def read_rows(prefs, refresh):
    """全国なら全国版の CSV を1つ、そうでなければ都道府県ごとの CSV を読む"""
    if prefs == ALL_PREFS:
        sources = [download(NATIONAL_URL, "mergeFromCity_2.csv", refresh)]
    else:
        sources = [download(PREFECTURE_URL.format(pref=p), f"{p:02d}000_2.csv", refresh) for p in prefs]
    for path in sources:
        with open(path, encoding="utf-8-sig", newline="") as f:
            yield from csv.DictReader(f)


def coverage(prefs, shelters, refresh):
    """区市町村ごとの公開状況と、大雨に関係する種別ごとの件数。

    国土地理院のデータには、指定緊急避難場所を公開していない区市町村や、
    洪水などの指定が 0 件の区市町村がある。画面でその旨を知らせるために使う。
    """
    path = download(HISTORY_URL, "publicHistoryListData.csv", refresh)
    wanted = {f"{p:02d}" for p in prefs}
    counts = {}
    for s in shelters:
        c = counts.setdefault(s["muni"], Counter())
        c.update(h for h in s["hazards"] if h in RAIN_RELATED)

    result = {}
    latest = ""
    with open(path, encoding="utf-8-sig", newline="") as f:
        # 列: 市町村コード, 名称, 公開日, 最終更新日, 状況コード, 特筆事項
        for row in csv.reader(f):
            if len(row) < 2 or row[0][:2] not in wanted:
                continue
            c = counts.get(row[0], Counter())
            result[row[0]] = {
                "name": row[1],
                "status": row[5].strip() if len(row) > 5 else "",
                "counts": {h: c[h] for h in RAIN_RELATED},
            }
            if len(row) > 3 and row[3] > latest:
                latest = row[3]
    # 元データの最終更新日(各市町村の最終更新日のうち一番新しいもの)。
    # 作った日時ではなくこれを記録するので、元データが変わらなければ出力も変わらない(自動更新で空のコミットを作らない)
    return dict(sorted(result.items())), latest


def outliers(shelters, municipalities):
    """同じ市町村の避難場所の中心(中央値)から大きく離れた避難場所。座標の入力ミスの可能性"""
    by_muni = {}
    for s in shelters:
        by_muni.setdefault(s["muni"], []).append(s)
    found = []
    for muni, items in by_muni.items():
        center = (statistics.median(s["lat"] for s in items), statistics.median(s["lon"] for s in items))
        for s in items:
            d = distance_km(center, (s["lat"], s["lon"]))
            if d > OUTLIER_KM:
                found.append((d, municipalities.get(muni, {}).get("name", muni), s["name"]))
    return sorted(found, reverse=True)


def previous_count():
    try:
        return json.loads((OUT_DIR / "index.json").read_text(encoding="utf-8"))["count"]
    except (OSError, KeyError, ValueError):
        return None


def build(prefs, refresh, force):
    shelters = {}
    dropped = Counter()
    odd_flags = Counter()
    duplicates = 0
    total = 0

    for row in read_rows(prefs, refresh):
        total += 1
        shelter = parse_row(row, dropped, odd_flags)
        if shelter is None:
            continue
        if shelter["id"] in shelters:
            duplicates += 1
            continue
        shelters[shelter["id"]] = shelter

    meshes = {}
    for shelter in shelters.values():
        meshes.setdefault(mesh2_code(shelter["lat"], shelter["lon"]), []).append(shelter)

    municipalities, source_updated = coverage(prefs, shelters.values(), refresh)
    index = {
        "source": {
            "name": "国土地理院 指定緊急避難場所データ",
            "page": SOURCE_PAGE,
            "prefectures": "all" if prefs == ALL_PREFS else [f"{p:02d}" for p in prefs],
            "updatedAt": source_updated,
        },
        "notice": NOTICE,
        "hazardKeys": HAZARD_COLUMNS,
        "mesh": "2次メッシュ(緯度5分×経度7.5分、約10km四方)",
        "count": len(shelters),
        # 避難場所のあるメッシュ(画面はここにあるメッシュだけを取りに行く)
        "meshes": sorted(meshes),
        "municipalities": municipalities,
    }

    # ---- 報告 ----
    hazard_counts = Counter(h for s in shelters.values() for h in s["hazards"])
    sizes = sorted(len(items) for items in meshes.values())
    gaps = [m for m in municipalities.values() if not any(m["counts"].values())]
    print(f"読み込み: {total} 件 / 採用: {len(shelters)} 件 / 重複ID: {duplicates} 件")
    for reason, n in dropped.most_common():
        print(f"  除外 {reason}: {n} 件")
    for flag, n in odd_flags.most_common():
        print(f"  想定外のフラグ値 {flag}: {n} 件")
    print("災害種別ごとの件数:")
    for column, key in HAZARD_COLUMNS.items():
        print(f"  {column}: {hazard_counts[key]} 件")
    print(f"メッシュ数: {len(meshes)} / 1メッシュあたり 最小 {sizes[0]}・中央値 {sizes[len(sizes) // 2]}・最大 {sizes[-1]} 件")
    print(f"大雨に関係する避難場所が 0 件の区市町村: {len(gaps)} / {len(municipalities)}")
    far = outliers(shelters.values(), municipalities)
    print(f"同じ市町村の中心から {OUTLIER_KM}km 以上離れた避難場所(座標の確認候補、除外はしない): {len(far)} 件")
    for d, muni_name, name in far[:5]:
        print(f"  {muni_name} {name}: {d:.0f}km")

    # ---- 壊れたデータを公開しないための歯止め ----
    previous = previous_count()
    problems = []
    if total and sum(dropped.values()) / total > MAX_DROP_RATIO:
        problems.append(f"除外が {sum(dropped.values())} 件({sum(dropped.values()) / total:.1%})あります")
    if previous and len(shelters) < previous * MIN_RATIO_TO_PREVIOUS:
        problems.append(f"件数が前回の {previous} 件から {len(shelters)} 件に減っています")
    if problems and not force:
        sys.exit("書き出しを中止しました(壊れたデータの可能性): " + " / ".join(problems) + "。確認のうえ --force で実行できます")

    # 一時フォルダに書いてから入れ替える(途中で失敗しても、前のデータが残る)
    tmp_dir = OUT_DIR.with_name(OUT_DIR.name + ".tmp")
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True)
    for code, items in meshes.items():
        items.sort(key=lambda s: s["id"])
        with open(tmp_dir / f"{code}.json", "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, separators=(",", ":"))
    with open(tmp_dir / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    tmp_dir.replace(OUT_DIR)
    print(f"出力先: {OUT_DIR}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("prefs", nargs="*", type=int, help="都道府県コード(省略すると全国)")
    parser.add_argument("--refresh", action="store_true", help="元データをダウンロードし直す")
    parser.add_argument("--force", action="store_true", help="件数の急な減少などがあっても書き出す")
    args = parser.parse_args()
    if any(not 1 <= p <= 47 for p in args.prefs):
        sys.exit("都道府県コードは 1〜47 で指定してください")
    build(sorted(set(args.prefs)) or ALL_PREFS, args.refresh, args.force)


if __name__ == "__main__":
    main()
