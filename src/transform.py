"""Nearest airborne aircraft from adsb.lol; bearing from query point.

Route origin→destination is NOT available in direct GET mode: TRMNL can poll
multiple URLs / POST a static body, but cannot chain callsigns from the nearby
response into routeset/route lookups in the same refresh. Point polling_url at
the Cloudflare Worker (worker/) for routes. Direct mode leaves route blank.
"""
import re

AIRLINES = {
    "BAW": "British Airways", "EZY": "easyJet", "EJU": "easyJet Europe",
    "RYR": "Ryanair", "TOM": "TUI", "VIR": "Virgin Atlantic", "EXS": "Jet2",
    "BEE": "Flybe", "AFR": "Air France", "DLH": "Lufthansa", "KLM": "KLM",
    "UAL": "United", "AAL": "American", "DAL": "Delta", "SWR": "SWISS",
    "EIN": "Aer Lingus", "WZZ": "Wizz",
    "WUK": "Wizz", "NAX": "Norwegian", "SAS": "SAS",
    "QTR": "Qatar", "UAE": "Emirates", "ETH": "Etihad",
    "ETD": "Etihad", "THY": "Turkish",
    "SIA": "Singapore", "CPA": "Cathay", "ACA": "Air Canada", "CFG": "Condor",
    "ICE": "Icelandair", "FIN": "Finnair", "LOT": "LOT", "AZA": "ITA",
    "IBE": "Iberia", "VLG": "Vueling", "TRA": "Transavia", "SHT": "BA Shuttle",
    "RJA": "Royal Jordanian", "LOG": "Loganair", "KLC": "KLM Cityhopper",
    "AEE": "Aegean", "HLE": "Helicentre",
}

COMPASS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def _airline(flight):
    call = (flight or "").strip().upper()
    if len(call) < 3:
        return ""
    if call[:3] in AIRLINES:
        return AIRLINES[call[:3]]
    m = re.match(r"^([A-Z]{2,3})", call)
    if m and m.group(1) in AIRLINES:
        return AIRLINES[m.group(1)]
    return ""


def _num(v, default=None):
    if v is None or v == "ground":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _is_airborne(a):
    cat = (a.get("category") or "").strip().upper()
    if cat.startswith("C"):
        return False
    typ = (a.get("t") or "").strip().upper()
    reg = (a.get("r") or "").strip().upper()
    if typ in ("TWR", "GND", "VEH", "GRND", "SERV") or reg in ("TWR", "GND", "VEH", "GRND"):
        return False
    if a.get("alt_baro") == "ground":
        return False
    gs = _num(a.get("gs"), None)
    if gs is not None and gs < 50:
        return False
    if _num(a.get("alt_baro"), None) is None and gs is None:
        return False
    return True


def _alt_display(a):
    alt = a.get("alt_baro")
    if alt == "ground":
        return "GND", -1
    baro = _num(alt, None)
    geom = _num(a.get("alt_geom"), None)
    if baro is not None and baro < 0 and geom is not None:
        n = geom
    elif baro is not None:
        n = baro
    else:
        n = geom
    if n is None:
        return "—", 999999
    if n < 0:
        n = 0
    if n >= 18000:
        return f"FL{int(round(n / 100)):03d}", n
    return f"{int(round(n)):,} ft", n


def _ident(a):
    flight = (a.get("flight") or "").strip()
    reg = (a.get("r") or "").strip()
    hx = (a.get("hex") or "").strip().upper()
    if flight:
        return flight, reg or "—", hx
    if reg:
        return reg, reg, hx
    if hx:
        return hx, "—", hx
    return "UNKNOWN", "—", ""


def _bearing(dir_deg):
    d = _num(dir_deg, None)
    if d is None:
        return None
    return COMPASS8[int((d % 360) / 45 + 0.5) % 8]


def _dst_brg(dst, bearing):
    if dst is None and not bearing:
        return "—"
    parts = []
    if dst is not None:
        parts.append(f"{dst:.1f} nm")
    if bearing:
        parts.append(bearing)
    return " ".join(parts)


def run(input):
    # Worker already shaped: routed live or history
    if input.get("mode") in ("routed", "history") and isinstance(input.get("planes"), list):
        planes = input["planes"][:5]
        return {
            "planes": planes,
            "count": len(planes),
            "mode": input.get("mode"),
            "label": input.get("label") or ("Last 5 overhead" if input.get("mode") == "history" else "Nearest airborne"),
            "centre": input.get("centre") or "",
            "total_in_radius": input.get("total_in_radius") or input.get("total_tracked") or len(planes),
            "airborne_in_radius": input.get("airborne_in_radius") or len(planes),
            "has_routes": True,
        }

    ac = input.get("ac") or input.get("aircraft") or input.get("data") or []
    if not isinstance(ac, list):
        ac = []

    total = input.get("total") if input.get("total") is not None else len(ac)
    enriched = []
    for a in ac:
        if not _is_airborne(a):
            continue
        flight, reg, hx = _ident(a)
        alt_s, alt_n = _alt_display(a)
        gs = _num(a.get("gs"), None)
        track = _num(
            a.get("true_heading") if a.get("true_heading") is not None else a.get("track"),
            None,
        )
        dst = _num(a.get("dst"), None)
        bearing = _bearing(a.get("dir"))
        seen = _num(a.get("seen"), 0) or 0
        airline = _airline(flight) if (a.get("flight") or "").strip() else ""
        typ = (a.get("t") or "").strip() or "—"
        enriched.append({
            "flight": flight,
            "reg": reg,
            "type": typ,
            "alt": alt_s,
            "alt_n": alt_n,
            "gs": f"{int(round(gs))}" if gs is not None else "—",
            "hdg": f"{int(round(track)):03d}°" if track is not None else "—",
            "dst": f"{dst:.1f}" if dst is not None else "—",
            "dst_n": dst if dst is not None else 999,
            "bearing": bearing,
            "dst_brg": _dst_brg(dst, bearing),
            "seen": f"{int(seen)}s",
            "seen_n": seen,
            "airline": airline or None,
            "route": None,  # needs Worker — cannot chain in TRMNL polling
            "hex": hx,
        })

    enriched.sort(key=lambda x: (x["dst_n"], x["seen_n"]))
    planes = enriched[:5]

    return {
        "planes": planes,
        "count": len(planes),
        "total_in_radius": total,
        "airborne_in_radius": len(enriched),
        "mode": "live",
        "label": "Nearest airborne",
        "centre": "",
        "has_routes": False,
    }
