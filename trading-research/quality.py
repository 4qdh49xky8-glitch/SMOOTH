"""Contrôles de qualité des prix journaliers. Aucune donnée n'est corrigée ni inventée :
on signale seulement les problèmes."""
from __future__ import annotations

import pandas as pd

COLUMNS = ["date", "open", "high", "low", "close", "volume"]


def check_prices(df: pd.DataFrame, name: str, today_utc: pd.Timestamp | None = None) -> dict:
    """Retourne un dictionnaire de constats sur un tableau journalier (colonnes COLUMNS)."""
    report: dict = {"name": name, "rows": int(len(df))}
    if df.empty:
        report["empty"] = True
        return report

    d = pd.to_datetime(df["date"], utc=True)
    report["first_date"] = str(d.min().date())
    report["last_date"] = str(d.max().date())
    report["duplicate_dates"] = int(d.duplicated().sum())
    report["not_sorted"] = bool(not d.is_monotonic_increasing)

    unique_days = pd.DatetimeIndex(d.dt.normalize().drop_duplicates()).sort_values()
    full = pd.date_range(unique_days.min(), unique_days.max(), freq="D", tz="UTC")
    missing = full.difference(unique_days)
    report["missing_days"] = int(len(missing))
    report["missing_days_examples"] = [str(x.date()) for x in missing[:5]]

    for col in ["open", "high", "low", "close", "volume"]:
        report[f"nan_{col}"] = int(df[col].isna().sum())
    prices = df[["open", "high", "low", "close"]]
    report["non_positive_prices"] = int((prices <= 0).any(axis=1).sum())
    report["high_below_low"] = int((df["high"] < df["low"]).sum())
    report["open_or_close_outside_range"] = int(
        ((df["open"] > df["high"]) | (df["open"] < df["low"]) | (df["close"] > df["high"]) | (df["close"] < df["low"])).sum()
    )
    report["zero_volume_days"] = int((df["volume"] <= 0).sum())

    ordered = df.assign(_d=d).sort_values("_d")
    ret = ordered["close"].pct_change()
    report["abs_daily_move_over_30pct"] = int((ret.abs() > 0.30).sum())
    report["max_abs_daily_move_pct"] = round(float(ret.abs().max() * 100), 2) if len(ret) > 1 else 0.0

    if today_utc is not None:
        report["days_since_last_candle"] = int((today_utc.normalize() - d.max().normalize()).days)
    return report


def compare_sources(a: pd.DataFrame, b: pd.DataFrame, label_a: str, label_b: str) -> dict:
    """Compare les clôtures de deux sources indépendantes sur les dates communes."""
    da = a.assign(date=pd.to_datetime(a["date"], utc=True).dt.normalize()).drop_duplicates("date").set_index("date")
    db = b.assign(date=pd.to_datetime(b["date"], utc=True).dt.normalize()).drop_duplicates("date").set_index("date")
    common = da.index.intersection(db.index)
    out: dict = {"sources": f"{label_a} vs {label_b}", "common_days": int(len(common))}
    if len(common) == 0:
        out["note"] = "aucune date commune"
        return out
    diff = (da.loc[common, "close"] / db.loc[common, "close"] - 1).abs() * 100
    out["median_abs_close_diff_pct"] = round(float(diff.median()), 4)
    out["max_abs_close_diff_pct"] = round(float(diff.max()), 4)
    out["days_close_diff_over_1pct"] = int((diff > 1).sum())
    out["worst_day"] = str(diff.idxmax().date())
    return out


def format_report(report: dict) -> str:
    return "\n".join(f"  {k}: {v}" for k, v in report.items())
