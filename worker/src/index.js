/**
 * Recommended mode for Planes Overhead when you want origin→destination routes.
 *
 * Why a Worker: TRMNL polling can hit multiple URLs and POST a static body, but
 * cannot take callsigns from the nearby ADS-B response and feed them into
 * routeset/route lookups in the same refresh. This Worker:
 *   1) GET adsb.lol /v2/lat/... nearby
 *   2) Filter airborne, take 5 nearest
 *   3) Resolve routes via POST /api/0/routeset (often empty), then
 *      GET /api/0/route/{callsign}, then adsbdb.com /v0/callsign/{cs}
 *   4) Return merged JSON { mode: "routed", planes: [...] }
 *
 * Optional KV: set OVERHEAD_KV + ?history=1 for rolling "last 5 overhead".
 *
 * Point TRMNL polling_url at this Worker. Query: ?lat=&lon=&nm=
 */
const ADSB_NEAR = (lat, lon, nm) =>
  `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`;
const ADSB_ROUTE = (cs) =>
  `https://api.adsb.lol/api/0/route/${encodeURIComponent(cs)}`;
const ADSB_ROUTESET = "https://api.adsb.lol/api/0/routeset";
const ADSBDB = (cs) =>
  `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`;

const AIRLINES = {
  BAW: "British Airways", EZY: "easyJet", EJU: "easyJet Europe", RYR: "Ryanair",
  TOM: "TUI", VIR: "Virgin Atlantic", EXS: "Jet2", SWR: "SWISS", AFR: "Air France",
  DLH: "Lufthansa", KLM: "KLM", EIN: "Aer Lingus", WZZ: "Wizz", WUK: "Wizz", UAL: "United",
  AAL: "American", DAL: "Delta", SHT: "BA Shuttle", THY: "Turkish", ICE: "Icelandair",
  RJA: "Royal Jordanian", UAE: "Emirates", SAS: "SAS", KLC: "KLM Cityhopper",
  AEE: "Aegean", QTR: "Qatar", ETH: "Etihad", ETD: "Etihad",
};
const COMPASS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function airline(flight) {
  const c = (flight || "").trim().toUpperCase();
  return AIRLINES[c.slice(0, 3)] || null;
}

function isAirborne(a) {
  const cat = (a.category || "").toUpperCase();
  if (cat.startsWith("C")) return false;
  const typ = (a.t || "").trim().toUpperCase();
  const reg = (a.r || "").trim().toUpperCase();
  if (["TWR", "GND", "VEH", "GRND", "SERV"].includes(typ) || ["TWR", "GND", "VEH", "GRND"].includes(reg)) {
    return false;
  }
  if (a.alt_baro === "ground") return false;
  if (a.gs != null && Number(a.gs) < 50) return false;
  return true;
}

function altDisplay(a) {
  if (a.alt_baro === "ground") return "GND";
  let n = a.alt_baro != null && a.alt_baro !== "ground" ? Number(a.alt_baro) : null;
  if (n == null || Number.isNaN(n)) n = a.alt_geom != null ? Number(a.alt_geom) : null;
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 0 && a.alt_geom != null) n = Number(a.alt_geom);
  if (n < 0) n = 0;
  if (n >= 18000) return `FL${String(Math.round(n / 100)).padStart(3, "0")}`;
  return `${Math.round(n).toLocaleString("en-GB")} ft`;
}

function bearing(dir) {
  if (dir == null || Number.isNaN(Number(dir))) return null;
  return COMPASS8[Math.round((((Number(dir) % 360) + 360) % 360) / 45) % 8];
}

function dstBrg(dst, brg) {
  const parts = [];
  if (dst != null && !Number.isNaN(Number(dst))) parts.push(`${Number(dst).toFixed(1)} nm`);
  if (brg) parts.push(brg);
  return parts.join(" ") || "—";
}

function ident(a) {
  const flight = (a.flight || "").trim();
  const reg = (a.r || "").trim();
  const hx = (a.hex || "").trim().toUpperCase();
  if (flight) return { flight, reg: reg || "—", hex: hx };
  if (reg) return { flight: reg, reg, hex: hx };
  if (hx) return { flight: hx, reg: "—", hex: hx };
  return { flight: "UNKNOWN", reg: "—", hex: "" };
}

function fmtAirport(loc, iata, icao) {
  const code = iata || icao || "";
  const place = loc || "";
  if (place && code) return `${place} (${code})`;
  return place || code || "";
}

function routeFromAdsbLol(data) {
  if (!data || !Array.isArray(data._airports) || data._airports.length < 2) return null;
  const [o, d] = data._airports;
  const left = fmtAirport(o.location, o.iata, o.icao);
  const right = fmtAirport(d.location, d.iata, d.icao);
  if (!left || !right) return null;
  return `${left} → ${right}`;
}

function routeFromAdsbdb(data) {
  const fr = data?.response?.flightroute;
  if (!fr) return null;
  const o = fr.origin || {};
  const d = fr.destination || {};
  const left = fmtAirport(o.municipality, o.iata_code, o.icao_code);
  const right = fmtAirport(d.municipality, d.iata_code, d.icao_code);
  if (!left || !right) return null;
  return `${left} → ${right}`;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function resolveRoutes(planes) {
  // Map callsign → route string
  const out = new Map();
  const withCs = planes.filter((p) => p.callsign);

  // 1) Batch routeset (documented; currently often empty 201)
  try {
    const body = {
      planes: withCs.map((p) => ({ callsign: p.callsign, lat: p.lat, lng: p.lng })),
    };
    const rs = await fetchJson(ADSB_ROUTESET, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "trmnl-planes-overhead-worker/1.1" },
      body: JSON.stringify(body),
    });
    if (Array.isArray(rs)) {
      for (const row of rs) {
        const cs = (row.callsign || row._callsign || "").trim();
        const route = routeFromAdsbLol(row) || null;
        if (cs && route) out.set(cs, route);
      }
    } else if (rs && typeof rs === "object") {
      for (const [k, v] of Object.entries(rs)) {
        const route = routeFromAdsbLol(v);
        if (route) out.set(k.trim(), route);
      }
    }
  } catch {
    /* ignore */
  }

  // 2) Per-callsign GET /api/0/route/{cs} then adsbdb
  await Promise.all(
    withCs.map(async (p) => {
      if (out.has(p.callsign)) return;
      const lol = await fetchJson(ADSB_ROUTE(p.callsign), {
        headers: { "User-Agent": "trmnl-planes-overhead-worker/1.1", Accept: "application/json" },
      });
      let route = routeFromAdsbLol(lol);
      if (!route) {
        const db = await fetchJson(ADSBDB(p.callsign), {
          headers: { "User-Agent": "trmnl-planes-overhead-worker/1.1", Accept: "application/json" },
        });
        route = routeFromAdsbdb(db);
      }
      if (route) out.set(p.callsign, route);
    })
  );

  return out;
}

function shape(a, routeMap) {
  const id = ident(a);
  const track = a.true_heading ?? a.track;
  const dst = a.dst != null ? Number(a.dst) : null;
  const brg = bearing(a.dir);
  const hasCall = !!(a.flight || "").trim();
  const cs = id.flight;
  return {
    flight: id.flight,
    reg: id.reg,
    type: (a.t || "").trim() || "—",
    alt: altDisplay(a),
    gs: a.gs != null ? String(Math.round(a.gs)) : "—",
    hdg: track != null ? `${Math.round(track).toString().padStart(3, "0")}°` : "—",
    dst: dst != null ? dst.toFixed(1) : "—",
    dst_n: dst ?? 999,
    bearing: brg,
    dst_brg: dstBrg(dst, brg),
    airline: hasCall ? airline(a.flight) : null,
    route: routeMap.get(cs) || null,
    hex: id.hex,
    seen_at: Date.now(),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const lat = url.searchParams.get("lat") || env.LAT || "52.0567";
    const lon = url.searchParams.get("lon") || env.LON || "1.1482";
    const nm = url.searchParams.get("nm") || env.RADIUS_NM || "12";
    const wantHistory = url.searchParams.get("history") === "1";

    const body = await fetchJson(ADSB_NEAR(lat, lon, nm), {
      headers: { "User-Agent": "trmnl-planes-overhead-worker/1.1" },
    });
    if (!body) {
      return Response.json({ error: "adsb_upstream" }, { status: 502 });
    }
    const now = Array.isArray(body.ac) ? body.ac : [];
    const airborne = now.filter(isAirborne).sort((a, b) => (a.dst ?? 999) - (b.dst ?? 999));
    const top = airborne.slice(0, 5);

    const routeInputs = top
      .map((a) => {
        const cs = (a.flight || "").trim();
        if (!cs || a.lat == null || a.lon == null) return null;
        return { callsign: cs, lat: a.lat, lng: a.lon };
      })
      .filter(Boolean);

    const routeMap = await resolveRoutes(routeInputs);
    const planes = top.map((a) => shape(a, routeMap));

    // Optional history merge into KV
    if (wantHistory && env.OVERHEAD_KV) {
      const key = `overhead:${lat}:${lon}:${nm}`;
      let hist = [];
      try {
        hist = JSON.parse((await env.OVERHEAD_KV.get(key)) || "[]");
      } catch {
        hist = [];
      }
      const byHex = new Map(hist.map((p) => [p.hex, p]));
      for (const p of planes) {
        if (p.hex) byHex.set(p.hex, p);
      }
      const merged = [...byHex.values()]
        .sort((a, b) => (b.seen_at || 0) - (a.seen_at || 0))
        .slice(0, 40);
      await env.OVERHEAD_KV.put(key, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 });
      const histPlanes = merged.slice(0, 5);
      return Response.json({
        mode: "history",
        label: "Last 5 overhead",
        centre: `${lat},${lon}`,
        planes: histPlanes,
        count: histPlanes.length,
        total_tracked: merged.length,
        airborne_in_radius: airborne.length,
        total_in_radius: body.total ?? now.length,
        has_routes: true,
      });
    }

    return Response.json(
      {
        mode: "routed",
        label: "Nearest airborne",
        centre: `${lat},${lon}`,
        planes,
        count: planes.length,
        airborne_in_radius: airborne.length,
        total_in_radius: body.total ?? now.length,
        has_routes: true,
      },
      { headers: { "Cache-Control": "public, max-age=30" } }
    );
  },
};
