"""build_shelters.py のテスト。

実行(リポジトリのルートで):
    python -I -m unittest discover -s scripts
"""

import unittest
from collections import Counter

from build_shelters import mesh2_bounds, mesh2_code, parse_row


def row(**overrides):
    base = {
        "共通ID": "E1311700115201",
        "施設・場所名": "区立王子桜中学校",
        "住所": "東京都北区王子2-7-1",
        "洪水": "1",
        "崖崩れ、土石流及び地滑り": "",
        "高潮": "1",
        "地震": "1",
        "津波": "",
        "大規模な火事": "",
        "内水氾濫": "",
        "火山現象": "",
        "指定避難所との住所同一": "1",
        "緯度": "35.758357",
        "経度": "139.736233",
        "備考": "",
    }
    base.update(overrides)
    return base


class MeshTest(unittest.TestCase):
    def test_known_codes(self):
        # 東京駅は 533946(2次メッシュ)
        self.assertEqual(mesh2_code(35.6812, 139.7671), "533946")
        # 父島(小笠原村)も日本の範囲として扱える
        self.assertEqual(mesh2_code(27.0944, 142.1917), "404251")

    def test_bounds_contain_point(self):
        for lat, lon in [(35.6812, 139.7671), (35.758357, 139.736233), (27.0944, 142.1917)]:
            south, west, north, east = mesh2_bounds(mesh2_code(lat, lon))
            self.assertTrue(south <= lat < north and west <= lon < east, (lat, lon))


class ParseRowTest(unittest.TestCase):
    def parse(self, **overrides):
        dropped, odd = Counter(), Counter()
        return parse_row(row(**overrides), dropped, odd), dropped, odd

    def test_normal_row(self):
        shelter, dropped, odd = self.parse()
        self.assertEqual(shelter["hazards"], ["flood", "storm_surge", "earthquake"])
        self.assertTrue(shelter["alsoShelter"])
        self.assertFalse(dropped or odd)

    def test_missing_coordinates_are_dropped(self):
        shelter, dropped, _ = self.parse(緯度="")
        self.assertIsNone(shelter)
        self.assertEqual(dropped["座標なし・数値でない"], 1)

    def test_swapped_coordinates_are_dropped(self):
        shelter, dropped, _ = self.parse(緯度="139.736233", 経度="35.758357")
        self.assertIsNone(shelter)
        self.assertEqual(dropped["座標が日本の範囲外"], 1)

    def test_unexpected_flag_value_is_reported(self):
        shelter, _, odd = self.parse(洪水="○")
        self.assertNotIn("flood", shelter["hazards"])
        self.assertEqual(odd["洪水=○"], 1)


if __name__ == "__main__":
    unittest.main()
