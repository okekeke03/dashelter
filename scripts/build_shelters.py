"""国土地理院の指定緊急避難場所データを、アプリで使う形に整形する。

- 元データ(CSV)を data/raw/ にダウンロードする(すでにあれば再利用)
- 項目名を英語のキーにそろえ、災害種別のフラグを配列にする
- 座標が欠けている・日本の範囲外にあるデータは除外し、理由を集計する
- 2次メッシュ(約10km四方)ごとに分割して web/public/data/shelters/ に書き出す

使い方(リポジトリのルートで実行):
    python -I scripts/build_shelters.py            # 東京都
    python -I scripts/build_shelters.py 13 14      # 東京都と神奈川県
    python -I scripts/build_shelters.py --refresh  # 元データを取り直す
"""

import argparse
import csv
import json
import math
import shutil
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "web" / "public" / "data" / "shelters"

SOURCE_URL = "https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/csv/{pref:02d}000_2.csv"
SOURCE_PAGE = "https://hinanmap.gsi.go.jp/hinanjocp/hinanbasho/koukaidate.html"

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


def download(pref, refresh):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path = RAW_DIR / f"{pref:02d}000_2.csv"
    if path.exists() and not refresh:
        return path
    url = SOURCE_URL.format(pref=pref)
    print(f"ダウンロード: {url}")
    with urllib.request.urlopen(url, timeout=60) as res, open(path, "wb") as f:
        shutil.copyfileobj(res, f)
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
        "name": name,
        "address": (row.get("住所") or "").strip(),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "hazards": hazards,
        "alsoShelter": (row.get("指定避難所との住所同一") or "").strip() == "1",
        "note": (row.get("備考") or "").strip(),
    }


def build(prefs, refresh):
    shelters = {}
    dropped = Counter()
    odd_flags = Counter()
    duplicates = 0
    total = 0

    for pref in prefs:
        path = download(pref, refresh)
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
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

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)
    for code, items in meshes.items():
        items.sort(key=lambda s: s["id"])
        with open(OUT_DIR / f"{code}.json", "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, separators=(",", ":"))

    index = {
        "source": {
            "name": "国土地理院 指定緊急避難場所データ",
            "page": SOURCE_PAGE,
            "prefectures": [f"{p:02d}" for p in prefs],
            "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        "notice": NOTICE,
        "hazardKeys": HAZARD_COLUMNS,
        "mesh": "2次メッシュ(緯度5分×経度7.5分、約10km四方)",
        "count": len(shelters),
        "meshes": {
            code: {"count": len(items), "bounds": mesh2_bounds(code)}
            for code, items in sorted(meshes.items())
        },
    }
    with open(OUT_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    hazard_counts = Counter(h for s in shelters.values() for h in s["hazards"])
    sizes = sorted(len(items) for items in meshes.values())
    print(f"読み込み: {total} 件 / 採用: {len(shelters)} 件 / 重複ID: {duplicates} 件")
    for reason, n in dropped.most_common():
        print(f"  除外 {reason}: {n} 件")
    for flag, n in odd_flags.most_common():
        print(f"  想定外のフラグ値 {flag}: {n} 件")
    print("災害種別ごとの件数:")
    for column, key in HAZARD_COLUMNS.items():
        print(f"  {column}: {hazard_counts[key]} 件")
    print(f"メッシュ数: {len(meshes)} / 1メッシュあたり 最小 {sizes[0]}・中央値 {sizes[len(sizes) // 2]}・最大 {sizes[-1]} 件")
    print(f"出力先: {OUT_DIR}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("prefs", nargs="*", type=int, default=[13], help="都道府県コード(既定: 13 = 東京都)")
    parser.add_argument("--refresh", action="store_true", help="元データをダウンロードし直す")
    args = parser.parse_args()
    if any(not 1 <= p <= 47 for p in args.prefs):
        sys.exit("都道府県コードは 1〜47 で指定してください")
    build(args.prefs, args.refresh)


if __name__ == "__main__":
    main()
