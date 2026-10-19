"""気象庁の地域コード表(area.json)から、市町村等(class20)→ 府県予報区(office)の対応表を作る。

アプリは「市町村コード → 警報を取りに行く府県予報区」を調べるのにこの表を使う。
元の area.json(約260KB)を毎回読み込まずに済むよう、必要な項目だけに絞る。

使い方(リポジトリのルートで実行):
    python -I scripts/build_jma_areas.py
"""

import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "data" / "jma-areas.json"
SOURCE_URL = "https://www.jma.go.jp/bosai/common/const/area.json"


def office_of(area, code):
    """class20 → class15 → class10 → office とたどる。"""
    class15 = area["class20s"][code]["parent"]
    class10 = area["class15s"][class15]["parent"]
    return area["class10s"][class10]["parent"]


def main():
    with urllib.request.urlopen(SOURCE_URL, timeout=60) as res:
        area = json.load(res)
    table = {code: [item["name"], office_of(area, code)] for code, item in sorted(area["class20s"].items())}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(table, f, ensure_ascii=False, separators=(",", ":"))
    print(f"市町村等: {len(table)} 件 / 府県予報区: {len({o for _, o in table.values()})} 件 → {OUT}")


if __name__ == "__main__":
    main()
