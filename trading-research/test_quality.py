"""Tests du contrôle qualité sur de petits tableaux construits à la main (jamais présentés comme des prix réels).
Lancement : python -m unittest -v"""
import unittest

import pandas as pd

from quality import check_prices, compare_sources


def frame(rows):
    return pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume"])


class QualityTests(unittest.TestCase):
    def test_clean_data_has_no_issue(self):
        df = frame([
            ("2024-01-01", 10, 12, 9, 11, 1),
            ("2024-01-02", 11, 13, 10, 12, 1),
            ("2024-01-03", 12, 14, 11, 13, 1),
        ])
        r = check_prices(df, "t")
        self.assertEqual(r["missing_days"], 0)
        self.assertEqual(r["duplicate_dates"], 0)
        self.assertEqual(r["high_below_low"], 0)
        self.assertEqual(r["open_or_close_outside_range"], 0)

    def test_detects_gap_duplicate_and_bad_candle(self):
        df = frame([
            ("2024-01-01", 10, 12, 9, 11, 1),
            ("2024-01-01", 10, 12, 9, 11, 1),   # doublon
            ("2024-01-04", 11, 9, 10, 12, 0),   # trou (2 et 3 janvier), haut < bas, volume nul
        ])
        r = check_prices(df, "t")
        self.assertEqual(r["duplicate_dates"], 1)
        self.assertEqual(r["missing_days"], 2)
        self.assertEqual(r["high_below_low"], 1)
        self.assertEqual(r["zero_volume_days"], 1)

    def test_compare_sources(self):
        a = frame([("2024-01-01", 1, 1, 1, 100, 1), ("2024-01-02", 1, 1, 1, 100, 1)])
        b = frame([("2024-01-01", 1, 1, 1, 100, 1), ("2024-01-02", 1, 1, 1, 102, 1)])
        r = compare_sources(a, b, "a", "b")
        self.assertEqual(r["common_days"], 2)
        self.assertGreater(r["max_abs_close_diff_pct"], 1.9)


if __name__ == "__main__":
    unittest.main()
