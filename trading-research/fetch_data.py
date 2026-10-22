"""ÉTAPE 1 — Télécharge des historiques JOURNALIERS PUBLICS (aucune clé, aucun compte, aucun ordre)
et contrôle leur qualité.

Sources :
  - Coinbase Exchange, endpoint public de chandeliers (historique long, BTC-EUR et ETH-EUR)
  - Kraken, endpoint public OHLC (source indépendante pour recouper ; seulement ~720 derniers jours)

Rien n'est inventé : si une source est indisponible, le programme le dit et continue.
Lancement : python fetch_data.py
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

from quality import COLUMNS, check_prices, compare_sources, format_report

HERE = Path(__file__).resolve().parent
RAW_DIR = HERE / "data" / "raw"
START = datetime(2017, 1, 1, tzinfo=timezone.utc)
HEADERS = {"User-Agent": "backtest-research/0.1 (donnees publiques uniquement)"}

MARKETS = {
    "BTC-EUR": {"coinbase": "BTC-EUR", "kraken": "XBTEUR"},
    "ETH-EUR": {"coinbase": "ETH-EUR", "kraken": "ETHEUR"},
}
COINBASE_URL = "https://api.exchange.coinbase.com/products/{product}/candles"
KRAKEN_URL = "https://api.kraken.com/0/public/OHLC"


class SourceUnavailable(Exception):
    pass


def _get_json(url: str, params: dict, tries: int = 4):
    last_error: Exception | None = None
    for attempt in range(tries):
        try:
            response = requests.get(url, params=params, headers=HEADERS, timeout=20)
            if response.status_code == 429:  # trop de requêtes : on attend
                time.sleep(2 * (attempt + 1))
                last_error = RuntimeError("HTTP 429 (limite de requêtes)")
                continue
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise SourceUnavailable(f"{url} : {last_error}")


def _utc_midnight_today() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def fetch_coinbase(product: str) -> pd.DataFrame:
    """Chandeliers journaliers (UTC), 300 jours maximum par requête. La bougie du jour en cours est exclue."""
    today = _utc_midnight_today()
    rows: list[list[float]] = []
    cursor = START
    while cursor < today:
        window_end = min(cursor + timedelta(days=299), today - timedelta(days=1))
        params = {
            "granularity": 86400,
            "start": cursor.isoformat(),
            "end": window_end.isoformat(),
        }
        data = _get_json(COINBASE_URL.format(product=product), params)
        if not isinstance(data, list):
            raise SourceUnavailable(f"réponse inattendue de Coinbase : {str(data)[:200]}")
        rows.extend(data)
        cursor += timedelta(days=300)
        time.sleep(0.4)  # politesse envers l'API publique
    # Format Coinbase : [temps, bas, haut, ouverture, clôture, volume]
    df = pd.DataFrame(rows, columns=["time", "low", "high", "open", "close", "volume"])
    df["date"] = pd.to_datetime(df["time"], unit="s", utc=True).dt.strftime("%Y-%m-%d")
    return df[COLUMNS].sort_values("date").reset_index(drop=True)


def fetch_kraken(pair: str) -> pd.DataFrame:
    data = _get_json(KRAKEN_URL, {"pair": pair, "interval": 1440})
    if data.get("error"):
        raise SourceUnavailable(f"Kraken a répondu une erreur : {data['error']}")
    result = data.get("result", {})
    keys = [k for k in result if k != "last"]
    if not keys:
        raise SourceUnavailable("Kraken : aucune série dans la réponse")
    # Format Kraken : [temps, ouverture, haut, bas, clôture, vwap, volume, nb_trades]
    df = pd.DataFrame(result[keys[0]], columns=["time", "open", "high", "low", "close", "vwap", "volume", "count"])
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col])
    df["date"] = pd.to_datetime(df["time"].astype(int), unit="s", utc=True).dt.strftime("%Y-%m-%d")
    today = _utc_midnight_today().strftime("%Y-%m-%d")
    df = df[df["date"] < today]  # on retire la bougie du jour, incomplète
    return df[COLUMNS].sort_values("date").reset_index(drop=True)


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    today = pd.Timestamp(_utc_midnight_today())
    lines: list[str] = [f"Rapport généré (UTC) : {datetime.now(timezone.utc).isoformat(timespec='seconds')}"]
    failures = 0
    frames: dict[tuple[str, str], pd.DataFrame] = {}

    for market, ids in MARKETS.items():
        for source, fetcher, ident in (("coinbase", fetch_coinbase, ids["coinbase"]), ("kraken", fetch_kraken, ids["kraken"])):
            title = f"{source} {market}"
            print(f"Téléchargement : {title} ...", flush=True)
            try:
                df = fetcher(ident)
            except SourceUnavailable as exc:
                failures += 1
                msg = f"INDISPONIBLE : {title} -> {exc}"
                print(msg)
                lines.append(msg)
                continue
            path = RAW_DIR / f"{source}_{market}_1d.csv"
            df.to_csv(path, index=False)
            frames[(source, market)] = df
            report = check_prices(df, title, today)
            lines.append(f"\n[{title}] fichier : {path.name}\n{format_report(report)}")

    for market in MARKETS:
        a, b = frames.get(("coinbase", market)), frames.get(("kraken", market))
        if a is not None and b is not None:
            lines.append(f"\n[RECOUPEMENT {market}]\n{format_report(compare_sources(a, b, 'coinbase', 'kraken'))}")
        else:
            lines.append(f"\n[RECOUPEMENT {market}] impossible : une des deux sources est indisponible.")

    text = "\n".join(lines)
    print("\n" + text)
    (HERE / "data" / "quality_report.txt").write_text(text, encoding="utf-8")
    print("\nRapport enregistré : data\\quality_report.txt")
    return 2 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
