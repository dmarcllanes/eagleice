from fasthtml.common import *
from starlette.responses import JSONResponse, StreamingResponse, Response
from starlette.staticfiles import StaticFiles
from collections import deque
import asyncio, httpx, json, os, polars as pl, time, re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

# ── Config ────────────────────────────────────────────────────────────────────
PH = dict(lamin=4.5, lomin=116.5, lamax=21.5, lomax=127.0)

ISS_API      = "http://api.open-notify.org/iss-now.json"
OPENSKY_API  = "https://opensky-network.org/api/states/all"  # kept as fallback
ADSBFI_API   = "https://opendata.adsb.fi/api/v2/all"  # free, no-auth
PHIVOLCS_URL = "https://earthquake.phivolcs.dost.gov.ph/"
USGS_API     = "https://earthquake.usgs.gov/fdsnws/event/1/query"
METEO_API    = "https://api.open-meteo.com/v1/forecast"
OVERPASS_API = "https://overpass-api.de/api/interpreter"
AQI_API      = "https://air-quality-api.open-meteo.com/v1/air-quality"
GDACS_API    = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP"
CELESTRAK_API= "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle"
EONET_API    = "https://eonet.gsfc.nasa.gov/api/v3/events"

AISHUB_USER  = os.environ.get("AISHUB_USER")  # set via env / HF Space secret
AISHUB_API   = "https://data.aishub.net/ws.php"
SHIP_TYPES   = {}

# ── NASA GIBS (Global Imagery Browse Services) ────────────────────────────────
GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
NASA_LAYERS = {
    # ── Default / Existing ────────────────────────────────────────────────────
    "visible":      "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    "modis":        "MODIS_Terra_CorrectedReflectance_TrueColor",
    "himawari":     "Himawari_AHI_Band03_Red",
    "nightlights":  "VIIRS_SNPP_DayNightBand_ENCC",
    "landtemp":     "MODIS_Terra_Land_Surface_Temp_Day",
    "falsecolor":   "MODIS_Terra_CorrectedReflectance_Bands721",
    # ── Atmosphere ────────────────────────────────────────────────────────────
    "aerosol":      "MODIS_Terra_Aerosol",
    "watervapor":   "MODIS_Terra_Water_Vapor_5km_Day",
    "precip":       "IMERG_Precipitation_Rate",
    # ── Biosphere ─────────────────────────────────────────────────────────────
    "chlorophyll":  "MODIS_Aqua_Chlorophyll_A",
    "vegetation":   "MODIS_Terra_NDVI_8Day",
    # ── Cryosphere ────────────────────────────────────────────────────────────
    "seaice":       "MODIS_Terra_Sea_Ice",
    "snowcover":    "MODIS_Terra_Snow_Cover_Daily",
    # ── Ocean ─────────────────────────────────────────────────────────────────
    "sst":          "GHRSST_L4_MUR_Sea_Surface_Temperature",
    "par":          "MODIS_Aqua_PAR",
    # ── Land Surface ──────────────────────────────────────────────────────────
    "soilmoisture": "SMAP_L3_Active_Passive_Soil_Moisture_Option1",
    "brighttemp":   "MODIS_Terra_Brightness_Temp_Band31_Day",
    # ── Specialized ───────────────────────────────────────────────────────────
    "goes_east":    "GOES-East_ABI_Band02_Red_Visible_1km",
    "hls":          "HLS_L30_Nadir_BRDF_Adjusted_Reflectance",
}
_nasa_img_cache: dict[str, bytes] = {}   # cache_key → jpeg bytes

WMO = {
    0:"Clear", 1:"Mainly Clear", 2:"Partly Cloudy", 3:"Overcast",
    45:"Fog", 48:"Icy Fog",
    51:"Lt Drizzle", 53:"Drizzle", 55:"Hvy Drizzle",
    61:"Lt Rain", 63:"Rain", 65:"Hvy Rain",
    80:"Showers", 81:"Rain Showers", 82:"Violent Showers",
    95:"Thunderstorm", 96:"TS + Hail", 99:"Severe TS",
}

# ── State ─────────────────────────────────────────────────────────────────────
class _TTL:
    def __init__(self, ttl: int):
        self.ttl = ttl; self.data = None; self.ts = 0.0
    def fresh(self): return self.data is not None and time.time() - self.ts < self.ttl
    def put(self, d): self.data = d; self.ts = time.time()

# Official PAGASA principal synoptic weather stations
PAGASA_STATIONS = [
    {"name": "Manila",          "lat": 14.5219, "lng": 120.9720},
    {"name": "Baguio",          "lat": 16.4132, "lng": 120.5990},
    {"name": "Laoag",           "lat": 18.1980, "lng": 120.5310},
    {"name": "Dagupan",         "lat": 16.0430, "lng": 120.3350},
    {"name": "Legaspi",         "lat": 13.1392, "lng": 123.7348},
    {"name": "Puerto Princesa", "lat":  9.7420, "lng": 118.7360},
    {"name": "Cebu",            "lat": 10.3168, "lng": 123.9054},
    {"name": "Iloilo",          "lat": 10.7017, "lng": 122.5656},
    {"name": "Tacloban",        "lat": 11.2280, "lng": 125.0180},
    {"name": "Zamboanga",       "lat":  6.9072, "lng": 122.0730},
    {"name": "Cotabato",        "lat":  7.1572, "lng": 124.2190},
    {"name": "Davao",           "lat":  7.1275, "lng": 125.6480},
    {"name": "Cagayan de Oro",  "lat":  8.4810, "lng": 124.6310},
    {"name": "Surigao",         "lat":  9.7840, "lng": 125.4940},
    {"name": "General Santos",  "lat":  6.1060, "lng": 125.0990},
]

_ac_cache     = _TTL(15)
_wx_cache     = _TTL(600)
_sh_cache     = _TTL(30)
_aqi_cache    = _TTL(600)

# ── Polars 72-hour earthquake rolling store ────────────────────────────────────
EQ_SCHEMA = {"lat": pl.Float64, "lng": pl.Float64, "depth": pl.Float64,
             "mag": pl.Float64, "place": pl.String,  "time": pl.Int64}
_eq_df: pl.DataFrame = pl.DataFrame(schema=EQ_SCHEMA)
_eq_last_fetch: float = 0.0
EQ_POLL_TTL    = 300                   # seconds between USGS polls
EQ_WINDOW_MS   = 72 * 3_600_000       # 72 h rolling window in milliseconds
_gdacs_cache  = _TTL(600)
_sat_cache    = _TTL(3600)   # TLEs only need daily updates
_eonet_cache  = _TTL(300)    # NASA natural events, 5-min TTL

_iss: list[dict] = []
ISS_TRAIL_SECS = 90 * 60

_events: deque = deque(maxlen=20)
_last_ac_count = -1
_logged_eq_times: set = set()


def _log(tag: str, msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    _events.appendleft({"ts": ts, "tag": tag, "msg": msg})


# ── Fetch helpers ─────────────────────────────────────────────────────────────
def _iss_trim():
    cut = time.time() - ISS_TRAIL_SECS
    while _iss and _iss[0]["timestamp"] < cut:
        _iss.pop(0)


async def _get_iss() -> dict | None:
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(ISS_API, timeout=10.0)
        d = r.json()
        rec = {
            "timestamp": float(d["timestamp"]),
            "lat": float(d["iss_position"]["latitude"]),
            "lng": float(d["iss_position"]["longitude"]),
        }
        _iss.append(rec)
        _iss_trim()
        return rec
    except Exception:
        return None


async def _get_aircraft() -> list:
    global _last_ac_count
    if _ac_cache.fresh():
        return _ac_cache.data
    try:
        # adsb.lol — free, confirmed working, 500nm radius around PH center
        async with httpx.AsyncClient() as c:
            r = await c.get(
                "https://api.adsb.lol/v2/point/12.8797/121.7740/500",
                timeout=15.0,
            )
        aircraft = r.json().get("ac") or []
        rows = [
            {
                "icao": a.get("hex", ""),
                "call": (a.get("flight") or a.get("hex", "")).strip(),
                "lat":  a.get("lat"),
                "lng":  a.get("lon"),
                "alt":  round(a.get("alt_baro") or a.get("alt_geom") or 0),
                "vel":  round((a.get("gs") or 0) * 1.852),
                "hdg":  round(a.get("track") or 0),
            }
            for a in aircraft
            if a.get("lat") is not None and a.get("lon") is not None
            and isinstance(a.get("alt_baro"), (int, float))
            and a.get("alt_baro") > 100  # airborne only (ft)
        ]
        if not rows and _ac_cache.data:
            _log("AIR", "adsb.lol empty — using cached data")
            return _ac_cache.data
        if len(rows) != _last_ac_count:
            _log("AIR", f"{len(rows)} aircraft via adsb.lol")
            _last_ac_count = len(rows)
        _ac_cache.put(rows)
        return rows
    except Exception as e:
        import traceback
        print(f"[AIR ERROR] {e}")
        traceback.print_exc()
        _log("AIR", f"error: {e}")
        return _ac_cache.data or []




class _PhivolcsTableParser(HTMLParser):
    """Minimal SAX-style parser — extracts all <td> text from a <table>."""
    def __init__(self):
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] = []
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []

    def handle_endtag(self, tag):
        if tag == "tr" and self._row:
            self.rows.append(self._row)
            self._row = []
        elif tag in ("td", "th") and self._cell is not None:
            self._row.append(" ".join(self._cell).strip())
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            stripped = data.strip()
            if stripped:
                self._cell.append(stripped)


_PH_TZ = timezone(timedelta(hours=8))   # Philippine Standard Time = UTC+8

_PHIVOLCS_DATE_FMTS = [
    "%d %B %Y - %I:%M %p",   # "29 July 2025 - 10:47 AM"
    "%d %B %Y - %H:%M",       # "29 July 2025 - 22:47"
    "%B %d, %Y %I:%M %p",     # "July 29, 2025 10:47 AM"
]

def _parse_phivolcs_date(s: str) -> int | None:
    """Parse a PHIVOLCS date string (PHT) → Unix timestamp in milliseconds."""
    s = re.sub(r"\s+", " ", s).strip()
    for fmt in _PHIVOLCS_DATE_FMTS:
        try:
            dt = datetime.strptime(s, fmt).replace(tzinfo=_PH_TZ)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return None


async def _fetch_phivolcs() -> list[dict]:
    """Scrape earthquake bulletin from PHIVOLCS website.
    Returns rows matching EQ_SCHEMA, or [] on any failure.
    """
    try:
        async with httpx.AsyncClient(verify=False, timeout=20.0) as c:
            r = await c.get(PHIVOLCS_URL, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code != 200:
            return []

        parser = _PhivolcsTableParser()
        parser.feed(r.text)

        rows = []
        for cells in parser.rows:
            # PHIVOLCS table: Date-Time | Lat | Lng | Depth | Mag | Location
            if len(cells) < 6:
                continue
            # Skip header rows
            if any(h in cells[0].lower() for h in ("date", "time", "latitude")):
                continue
            try:
                ts = _parse_phivolcs_date(cells[0])
                if ts is None:
                    continue
                lat   = float(cells[1])
                lng   = float(cells[2])
                depth = float(cells[3])
                mag   = float(cells[4])
                place = cells[5]
                # Only keep events within PH bounding box
                if not (PH["lamin"] <= lat <= PH["lamax"] and
                        PH["lomin"] <= lng <= PH["lomax"]):
                    continue
                rows.append({"lat": lat, "lng": lng, "depth": depth,
                             "mag": mag, "place": place, "time": ts})
            except (ValueError, IndexError):
                continue
        return rows
    except Exception as e:
        _log("EQ", f"PHIVOLCS scrape err: {str(e)[:40]}")
        return []


async def _get_earthquakes() -> list:
    global _eq_df, _eq_last_fetch
    now = time.time()
    cutoff_ms = int(now * 1000) - EQ_WINDOW_MS

    if now - _eq_last_fetch >= EQ_POLL_TTL:
        # ── Primary: PHIVOLCS bulletin scraper ──────────────────────────────
        new_rows = await _fetch_phivolcs()

        # ── Fallback: USGS FDSN if PHIVOLCS returned nothing ────────────────
        if not new_rows:
            _log("EQ", "PHIVOLCS empty — falling back to USGS")
            try:
                async with httpx.AsyncClient() as c:
                    r = await c.get(USGS_API, params={
                        "format":       "geojson",
                        "minlatitude":  PH["lamin"], "maxlatitude":  PH["lamax"],
                        "minlongitude": PH["lomin"], "maxlongitude": PH["lomax"],
                        "minmagnitude": 2.5,
                        "orderby":      "time",
                        "limit":        500,
                        "starttime":    (datetime.utcnow() - timedelta(hours=72)).strftime("%Y-%m-%dT%H:%M:%S"),
                    }, timeout=15.0)
                new_rows = [
                    {
                        "lat":   float(f["geometry"]["coordinates"][1]),
                        "lng":   float(f["geometry"]["coordinates"][0]),
                        "depth": float(f["geometry"]["coordinates"][2]),
                        "mag":   float(f["properties"]["mag"]),
                        "place": str(f["properties"]["place"] or ""),
                        "time":  int(f["properties"]["time"]),
                    }
                    for f in r.json().get("features", [])
                    if f["properties"].get("mag") is not None   # guard null mag
                ]
            except Exception as e:
                _log("EQ", f"USGS err: {str(e)[:40]}")
                new_rows = []

        if new_rows:
            new_df = pl.DataFrame(new_rows, schema=EQ_SCHEMA)
            existing = _eq_df.filter(pl.col("time") >= cutoff_ms)
            _eq_df = (
                pl.concat([existing, new_df])
                .unique(subset=["time"])
                .sort("time", descending=True)
            )
        for q in new_rows:
            if q["time"] not in _logged_eq_times:
                _logged_eq_times.add(q["time"])
                _log("EQ", f"M{q['mag']:.1f} · {(q['place'] or 'unknown')[:32]}")
        _eq_last_fetch = now

    return _eq_df.filter(pl.col("time") >= cutoff_ms).to_dicts()


async def _get_weather() -> list:
    if _wx_cache.fresh():
        return _wx_cache.data
    out = []
    try:
        async with httpx.AsyncClient() as c:
            for city in PAGASA_STATIONS:
                r = await c.get(METEO_API, params={
                    "latitude": city["lat"], "longitude": city["lng"],
                    "current": "temperature_2m,wind_speed_10m,weather_code,precipitation",
                    "timezone": "Asia/Manila",
                }, timeout=10.0)
                cur = r.json().get("current", {})
                out.append({
                    **city,
                    "temp": cur.get("temperature_2m"),
                    "wind": cur.get("wind_speed_10m"),
                    "rain": cur.get("precipitation"),
                    "cond": WMO.get(cur.get("weather_code", -1), "—"),
                })
        _log("WX", "Weather data refreshed")
        _wx_cache.put(out)
    except Exception:
        out = _wx_cache.data or []
    return out


async def _get_aqi() -> list:
    if _aqi_cache.fresh():
        return _aqi_cache.data
    out = []
    try:
        async with httpx.AsyncClient() as c:
            for city in PAGASA_STATIONS:
                r = await c.get(AQI_API, params={
                    "latitude": city["lat"], "longitude": city["lng"],
                    "current": "european_aqi,pm10,pm2_5",
                    "timezone": "Asia/Manila",
                }, timeout=10.0)
                cur = r.json().get("current", {})
                out.append({
                    **city,
                    "aqi": cur.get("european_aqi"),
                    "pm10": cur.get("pm10"),
                    "pm25": cur.get("pm2_5"),
                })
        _log("AQI", "Air Quality data refreshed")
        _aqi_cache.put(out)
    except Exception:
        out = _aqi_cache.data or []
    return out


async def _get_gdacs() -> list:
    if _gdacs_cache.fresh():
        return _gdacs_cache.data
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(GDACS_API, timeout=10.0)
        events = r.json().get("features", [])
        
        # Filter for recent high severity events
        disasters = []
        for f in events:
            props = f.get("properties", {})
            if props.get("alertlevel") in ["Orange", "Red"]:
                disasters.append({
                    "name": props.get("name"),
                    "type": props.get("eventtype"),
                    "severity": props.get("alertlevel"),
                    "desc": props.get("htmldescription"),
                    "lat": f["geometry"]["coordinates"][1],
                    "lng": f["geometry"]["coordinates"][0],
                })
                _log("ALRT", f"{props.get('eventtype')} - {props.get('name')}")
        _gdacs_cache.put(disasters)
        return disasters
    except Exception:
        return _gdacs_cache.data or []


# EONET category IDs → human labels + emoji
# NOTE: EONET API v3 uses string slugs for category IDs
_EONET_CATEGORIES = {
    "wildfires":    ("Wildfires",       "fire",     "🔥"),
    "severeStorms": ("Severe Storms",   "storm",    "🌀"),
    "volcanoes":    ("Volcanoes",       "volcano",  "🌋"),
    "seaLakeIce":   ("Sea and Lake Ice","cryo",     "🧊"),
}

async def _get_natural_events() -> list:
    """Fetch NASA EONET natural hazard events (last 60 days, open events only)."""
    if _eonet_cache.fresh():
        return _eonet_cache.data
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(EONET_API, params={
                "status": "open",
                "days":   60,
                "limit":  200,
            }, timeout=15.0)
        raw_events = r.json().get("events", [])
        out = []
        for ev in raw_events:
            cats = ev.get("categories", [])
            geo  = ev.get("geometry", [])
            if not cats or not geo:
                continue
            # v3 API: category id is a string slug e.g. "wildfires"
            cat_id = cats[0].get("id")
            info   = _EONET_CATEGORIES.get(cat_id)
            if not info:
                continue
            label, cat_key, emoji = info
            # Use the most recent geometry point
            latest = sorted(geo, key=lambda g: g.get("date", ""), reverse=True)[0]
            coords = latest.get("coordinates", [])
            if not coords or len(coords) < 2:
                continue
            try:
                lng, lat = float(coords[0]), float(coords[1])
            except (TypeError, ValueError):
                continue
            out.append({
                "id":      ev.get("id"),
                "title":   ev.get("title", "Unknown"),
                "cat":     cat_key,
                "emoji":   emoji,
                "label":   label,
                "lat":     lat,
                "lng":     lng,
                "date":    latest.get("date", "")[:10],
                "link":    (ev.get("sources") or [{}])[0].get("url", ""),
            })
        if out:
            _log("EONET", f"{len(out)} natural events loaded")
        _eonet_cache.put(out)
        return out
    except Exception as e:
        _log("EONET", f"fetch err: {str(e)[:40]}")
        return _eonet_cache.data or []


async def _get_satellites() -> str:
    if _sat_cache.fresh():
        return _sat_cache.data
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(CELESTRAK_API, timeout=15.0)
            text = r.text
            _log("SAT", f"Updated TLEs for {len(text.strip().split(chr(10)))//3} satellites")
            _sat_cache.put(text)
            return text
    except Exception:
        return _sat_cache.data or ""


def _ship_type(code: int) -> tuple[str, str]:
    for r, info in SHIP_TYPES.items():
        if code in r:
            return info
    return ("VESSEL", "#aaaaaa")


async def _get_ships() -> list:
    if _sh_cache.fresh():
        return _sh_cache.data
    if not AISHUB_USER:
        return []   # no AIS receiver registered — live data unavailable

    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(AISHUB_API, params={
                "username": AISHUB_USER,
                "format":   "1",
                "output":   "json",
                "compress": "0",
                "latmin":   PH["lamin"], "latmax": PH["lamax"],
                "lonmin":   PH["lomin"], "lonmax": PH["lomax"],
                "interval": "1",          # latest data, 1-min resolution
            }, timeout=10.0)
        raw = r.json()
        # AISHub returns [{meta}, [{vessel}, ...]]
        if len(raw) < 2 or raw[0].get("ERROR"):
            _log("SHP", f"AISHub err: {raw[0].get('ERROR','no data')}"[:48])
            return _sh_cache.data or []
        label, color = "VESSEL", "#aaaaaa"
        vessels = []
        for v in raw[1]:
            if v.get("LATITUDE") is None or v.get("LONGITUDE") is None:
                continue
            type_code = int(v.get("SHIPTYPE") or 0)
            label, color = _ship_type(type_code)
            vessels.append({
                "mmsi":  v.get("MMSI"),
                "name":  (v.get("NAME") or "UNKNOWN").strip(),
                "lat":   float(v["LATITUDE"]),
                "lng":   float(v["LONGITUDE"]),
                "hdg":   float(v.get("COG") or 0),
                "speed": float(v.get("SOG") or 0),
                "dest":  (v.get("DESTINATION") or "—").strip(),
                "type":  label,
                "color": color,
            })
        if vessels:
            _log("SHP", f"{len(vessels)} vessels in PH waters")
        _sh_cache.put(vessels)
        return vessels
    except Exception:
        return _sh_cache.data or []


# ── App ───────────────────────────────────────────────────────────────────────
app, rt = fast_app(
    pico=False,
    hdrs=(
        Meta(charset="UTF-8"),
        Meta(name="viewport", content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"),
        Meta(name="theme-color", content="#0b0f19"),
        Meta(name="apple-mobile-web-app-capable", content="yes"),
        Meta(name="apple-mobile-web-app-status-bar-style", content="black-translucent"),
        Link(rel="manifest", href="/static/manifest.json"),
        Link(rel="apple-touch-icon", href="/static/icon.svg"),
        Link(rel="stylesheet", href="/static/style.css"),
    )
)
app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Routes ────────────────────────────────────────────────────────────────────
@rt("/")
def get():
    return (
        Title("Eagleice | PH Sentinel"),
        Div(
            # Map
            Div(id="map"),

            # Always-on animated overlays
            Div(id="grid-overlay"),
            Div(id="radar-sweep"),
            Div(id="scan-sweep"),
            Div(id="radar-origin"),
            Div(id="vignette"),

            # Wordmark
            Div(
                Span("EAGLE", cls="logo-eagle"),
                Span("ICE",   cls="logo-ice"),
                Span("PH SENTINEL", cls="logo-sub"),
                id="wordmark",
            ),            # Mobile menu toggle
            Button("⚙️ CONTROLS", id="mobile-menu-btn", 
                   onclick="document.getElementById('right-ctrl').classList.toggle('open')"),
            # Mobile events toggle
            Button("📋 EVENTS", id="mobile-events-btn", 
                   onclick="document.getElementById('hud-right').classList.toggle('open')"),

            # Right-side control column (flex, scrollable)
            Div(
                # Layer controls
                Div(
                    Span("LAYERS", cls="ctrl-title"),
                    Div(
                        Button("AIRCRAFT", id="btn-ac",  cls="layer-btn active",
                               onclick="toggleLayer('ac')"),
                        Button("SEISMIC",  id="btn-eq",  cls="layer-btn active",
                               onclick="toggleLayer('eq')"),
                        Button("WEATHER",  id="btn-wx",  cls="layer-btn active",
                               onclick="toggleLayer('wx')"),
                        Button("SATELLITES", id="btn-sat", cls="layer-btn active",
                               onclick="toggleLayer('sat')"),
                        Button("SHIPS",    id="btn-sh",  cls="layer-btn active",
                               onclick="toggleLayer('sh')"),
                        cls="ctrl-btns",
                    ),
                    id="layer-ctrl",
                ),

                # View filter
                Div(
                    Span("VIEW", cls="ctrl-title"),
                    Div(
                        Button("NORMAL", cls="filter-btn active",
                               onclick="setFilter('normal', this)"),
                        Button("NVGS",   cls="filter-btn",
                               onclick="setFilter('nvgs', this)"),
                        Button("FLIR",   cls="filter-btn",
                               onclick="setFilter('flir', this)"),
                        cls="ctrl-btns",
                    ),
                    id="filter-ctrl",
                ),

                # Camera control
                Div(
                    Span("CAMERA", cls="ctrl-title"),
                    Div(
                        Button("⌖ RECENTER", id="btn-recenter", cls="filter-btn",
                               onclick="world.pointOfView({ lat: 12.8797, lng: 121.7740, altitude: 2 }, 1000)"),
                        cls="ctrl-btns",
                    ),
                    id="camera-ctrl",
                ),

                # NASA imagery selector — tabbed by science discipline
                Div(
                    Span("IMAGERY", cls="ctrl-title"),
                    # Discipline tab bar
                    Div(
                        Button("DEFAULT",    cls="imagery-tab active", onclick="switchImgTab('default',this)"),
                        Button("ATMOS",      cls="imagery-tab",        onclick="switchImgTab('atmos',this)"),
                        Button("BIO",        cls="imagery-tab",        onclick="switchImgTab('bio',this)"),
                        Button("CRYO",       cls="imagery-tab",        onclick="switchImgTab('cryo',this)"),
                        Button("OCEAN",      cls="imagery-tab",        onclick="switchImgTab('ocean',this)"),
                        Button("LAND",       cls="imagery-tab",        onclick="switchImgTab('land',this)"),
                        Button("SPEC",       cls="imagery-tab",        onclick="switchImgTab('spec',this)"),
                        cls="imagery-tabs",
                    ),
                    # Panels per tab
                    Div(
                        Button("DAY/NIGHT",  cls="nasa-btn active",    onclick="setNasaLayer('default',this)"),
                        Button("TRUE COLOR", cls="nasa-btn",           onclick="setNasaLayer('visible',this)"),
                        Button("MODIS",      cls="nasa-btn",           onclick="setNasaLayer('modis',this)"),
                        Button("HIMAWARI",   cls="nasa-btn",           onclick="setNasaLayer('himawari',this)"),
                        Button("CITY LIGHTS",cls="nasa-btn",           onclick="setNasaLayer('nightlights',this)"),
                        id="img-tab-default", cls="ctrl-btns img-tab-panel",
                    ),
                    Div(
                        Button("AEROSOL",    cls="nasa-btn",           onclick="setNasaLayer('aerosol',this)"),
                        Button("WATER VAPOR",cls="nasa-btn",           onclick="setNasaLayer('watervapor',this)"),
                        Button("PRECIP (IMERG)",cls="nasa-btn",        onclick="setNasaLayer('precip',this)"),
                        Button("LAND TEMP",  cls="nasa-btn",           onclick="setNasaLayer('landtemp',this)"),
                        id="img-tab-atmos", cls="ctrl-btns img-tab-panel", style="display:none",
                    ),
                    Div(
                        Button("CHLOROPHYLL-A",cls="nasa-btn",         onclick="setNasaLayer('chlorophyll',this)"),
                        Button("VEGETATION", cls="nasa-btn",           onclick="setNasaLayer('vegetation',this)"),
                        Button("FALSE COLOR",cls="nasa-btn",           onclick="setNasaLayer('falsecolor',this)"),
                        id="img-tab-bio", cls="ctrl-btns img-tab-panel", style="display:none",
                    ),
                    Div(
                        Button("SEA ICE",    cls="nasa-btn",           onclick="setNasaLayer('seaice',this)"),
                        Button("SNOW COVER", cls="nasa-btn",           onclick="setNasaLayer('snowcover',this)"),
                        id="img-tab-cryo", cls="ctrl-btns img-tab-panel", style="display:none",
                    ),
                    Div(
                        Button("SEA SURF TEMP",cls="nasa-btn",         onclick="setNasaLayer('sst',this)"),
                        Button("OCEAN COLOR / PAR",cls="nasa-btn",     onclick="setNasaLayer('par',this)"),
                        id="img-tab-ocean", cls="ctrl-btns img-tab-panel", style="display:none",
                    ),
                    Div(
                        Button("SOIL MOISTURE",cls="nasa-btn",         onclick="setNasaLayer('soilmoisture',this)"),
                        Button("BRIGHTNESS TEMP",cls="nasa-btn",       onclick="setNasaLayer('brighttemp',this)"),
                        id="img-tab-land", cls="ctrl-btns img-tab-panel", style="display:none",
                    ),
                    Div(
                        Button("GOES EAST",  cls="nasa-btn",           onclick="setNasaLayer('goes_east',this)"),
                        Button("HLS 30m",    cls="nasa-btn",           onclick="setNasaLayer('hls',this)"),
                        Button("BLACK MARBLE",cls="nasa-btn",          onclick="setNasaLayer('nightlights',this)"),
                        id="img-tab-spec", cls="ctrl-btns img-tab-panel", style="display:none",
                    ),
                    id="imagery-ctrl",
                ),

                # Natural events toggle panel
                Div(
                    Span("EVENTS", cls="ctrl-title"),
                    Div(
                        Button("🔥 WILDFIRES",  id="btn-ev-fire",    cls="layer-btn active",
                               onclick="toggleEventCategory('fire')"),
                        Button("🌀 STORMS",      id="btn-ev-storm",   cls="layer-btn active",
                               onclick="toggleEventCategory('storm')"),
                        Button("🌋 VOLCANIC",    id="btn-ev-volcano", cls="layer-btn active",
                               onclick="toggleEventCategory('volcano')"),
                        Button("🧊 CRYOSPHERE", id="btn-ev-cryo",    cls="layer-btn active",
                               onclick="toggleEventCategory('cryo')"),
                        cls="ctrl-btns",
                    ),
                    id="events-ctrl",
                ),

                id="right-ctrl",
            ),


            # Alert banner (populated by SSE)
            Div(id="alert-banner", cls="alert-banner", style="display:none"),

            # Left HUD panels
            Div(
                Div(id="hud-iss",
                    hx_get="/api/iss/hud",
                    hx_trigger="load, every 5s",
                    hx_swap="innerHTML"),
                Div(id="hud-stats",
                    hx_get="/api/stats/hud",
                    hx_trigger="load, every 15s",
                    hx_swap="innerHTML"),
                Div(id="hud-weather",
                    hx_get="/api/weather/hud",
                    hx_trigger="load, every 600s",
                    hx_swap="innerHTML"),
                Div(id="hud-disasters",
                    hx_get="/api/disasters/hud",
                    hx_trigger="load, every 600s",
                    hx_swap="innerHTML"),
                Div(id="hud-events-natural",
                    hx_get="/api/events/natural/hud",
                    hx_trigger="load, every 300s",
                    hx_swap="innerHTML"),
                # 4D time scrubber
                Div(
                    P(Span("4D TIME SCRUB", cls="hud-label"), cls="hud-title"),
                    Div(
                        Input(type="range", id="time-scrubber", min="0", max="48",
                              value="0", oninput="timeScrub(parseInt(this.value))",
                              cls="time-slider",
                              style="pointer-events:auto;width:100%;margin-bottom:4px"),
                        P(Span("LIVE", id="time-label", cls="hud-muted"),
                          style="text-align:center;font-size:11px"),
                        style="pointer-events:auto",
                    ),
                    id="hud-timescrub",
                ),
                id="hud-left",
            ),

            # Right event feed
            Div(
                Div(id="hud-events",
                    hx_get="/api/events/feed",
                    hx_trigger="load, every 5s",
                    hx_swap="innerHTML"),
                id="hud-right",
            ),

            # Cursor coords
            Div(id="cursor-coords", cls="cursor-coords"),

            Script(src="//unpkg.com/globe.gl"),
            Script(src="//cdnjs.cloudflare.com/ajax/libs/satellite.js/4.0.0/satellite.min.js"),
            Script(src="/static/custom.js"),
            Script("if('serviceWorker' in navigator) navigator.serviceWorker.register('/static/sw.js');"),
        ),
    )


# ── Threshold helper (for SSE alerts) ─────────────────────────────────────────
def _check_thresholds() -> list:
    alerts = []
    cutoff_6h = int((time.time() - 6 * 3600) * 1000)
    try:
        severe = _eq_df.filter(
            (pl.col("mag") >= 5.0) & (pl.col("time") >= cutoff_6h)
        ).to_dicts()
        for q in severe[:5]:
            alerts.append({
                "type":     "SEISMIC",
                "severity": "CRITICAL" if q["mag"] >= 6.0 else "HIGH",
                "msg":      f"M{q['mag']:.1f} · {(q['place'] or '')[:40]}",
                "lat":      q["lat"],
                "lng":      q["lng"],
            })
    except Exception:
        pass
    for city in (_aqi_cache.data or []):
        aqi = city.get("aqi") or 0
        if aqi >= 150:
            alerts.append({
                "type":     "AQI",
                "severity": "HIGH",
                "msg":      f"Hazardous AQI {aqi} in {city['name']}",
                "lat":      city["lat"],
                "lng":      city["lng"],
            })
    return alerts


# ── JSON endpoints ────────────────────────────────────────────────────────────
@rt("/api/iss")
async def get():
    rec = await _get_iss()
    if rec is None:
        if _iss: return JSONResponse({**_iss[-1], "stale": True})
        return JSONResponse({"error": "upstream timeout"}, status_code=503)
    return JSONResponse(rec)

@rt("/api/iss/trail")
def get_trail():
    return JSONResponse(_iss)

@rt("/api/satellites/tle")
async def get_tles():
    from starlette.responses import PlainTextResponse
    return PlainTextResponse(await _get_satellites())

@rt("/api/aircraft")
async def get():
    return JSONResponse(await _get_aircraft())

@rt("/api/earthquakes")
async def get():
    return JSONResponse(await _get_earthquakes())

@rt("/api/weather")
async def get():
    return JSONResponse(await _get_weather())

@rt("/api/nasa/globe")
async def get(layer: str = "visible"):
    """Proxy NASA GIBS WMS → equirectangular JPEG usable as Globe.gl texture."""
    layer_name = NASA_LAYERS.get(layer)
    if not layer_name:
        return Response(status_code=400)

    # Try today, fall back to yesterday if GIBS hasn't published yet (~3h delay)
    for days_ago in (0, 1, 2):
        date_str = (datetime.utcnow() - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        cache_key = f"{layer}_{date_str}"
        if cache_key in _nasa_img_cache:
            return Response(_nasa_img_cache[cache_key], media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=3600"})
        try:
            async with httpx.AsyncClient() as c:
                r = await c.get(GIBS_WMS, params={
                    "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.1.1",
                    "LAYERS":  layer_name,
                    "FORMAT":  "image/jpeg",
                    "HEIGHT":  "1024", "WIDTH": "2048",
                    "SRS":     "EPSG:4326",
                    "BBOX":    "-180,-90,180,90",
                    "TIME":    date_str,
                }, timeout=30.0)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                _nasa_img_cache[cache_key] = r.content
                _log("NASA", f"{layer} imagery loaded ({date_str}, {len(r.content)//1024}KB)")
                return Response(r.content, media_type="image/jpeg",
                                headers={"Cache-Control": "public, max-age=3600"})
        except Exception as e:
            _log("NASA", f"{layer} fetch err: {str(e)[:40]}")
    return Response(status_code=503)

@rt("/api/ships")
async def get():
    return JSONResponse(await _get_ships())

@rt("/api/aqi")
async def get():
    return JSONResponse(await _get_aqi())

@rt("/api/earthquakes/at")
async def get(hours_ago: int = 0):
    """4D time-scrub: returns quakes in the 24-h window ending `hours_ago` hours ago."""
    await _get_earthquakes()
    now_ms         = int(time.time() * 1000)
    window_end_ms  = now_ms - int(hours_ago * 3_600_000)
    window_start_ms = window_end_ms - int(24 * 3_600_000)
    result = _eq_df.filter(
        (pl.col("time") >= window_start_ms) & (pl.col("time") <= window_end_ms)
    ).to_dicts()
    return JSONResponse(result)

@rt("/api/alerts/stream")
async def get():
    """SSE stream: pushes JSON arrays of threshold-breaching alerts every 10 s."""
    async def event_stream():
        yield ": connected\n\n"
        seen: set[str] = set()
        while True:
            await asyncio.sleep(10)
            try:
                alerts = _check_thresholds()
                fresh  = [a for a in alerts if a["msg"] not in seen]
                if fresh:
                    for a in fresh:
                        seen.add(a["msg"])
                    yield f"data: {json.dumps(fresh)}\n\n"
                else:
                    yield ": keepalive\n\n"
            except Exception:
                yield ": keepalive\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@rt("/api/events/natural")
async def get():
    return JSONResponse(await _get_natural_events())


# ── HTMX fragment endpoints ───────────────────────────────────────────────────
@rt("/api/iss/hud")
async def get():
    if not _iss: await _get_iss()
    if not _iss: return P("Acquiring signal…", cls="hud-muted")
    r = _iss[-1]
    ts = datetime.fromtimestamp(r["timestamp"]).strftime("%H:%M:%S")
    return (
        P(Span("ISS TRACK", cls="hud-label"), cls="hud-title"),
        P(Span("LAT ", cls="hud-label"), f"{r['lat']:+.4f}°"),
        P(Span("LNG ", cls="hud-label"), f"{r['lng']:+.4f}°"),
        P(Span("PTS ", cls="hud-label"), f"{len(_iss)} stored"),
        P(Span("UPD ", cls="hud-label"), f"{ts} PHT", cls="hud-muted"),
    )


@rt("/api/stats/hud")
async def get():
    ac = _ac_cache.data or []
    eq = _eq_df.to_dicts()
    sh = _sh_cache.data or []
    sh_status = f"{len(sh)} tracked" if AISHUB_USER else "no AIS feed"
    return (
        P(Span("SURVEILLANCE", cls="hud-label"), cls="hud-title"),
        P(Span("AIRCRAFT ", cls="hud-label"), f"{len(ac)} airborne"),
        P(Span("VESSELS  ", cls="hud-label"), sh_status),
        P(Span("PHIVOLCS ", cls="hud-label"), f"{len(eq)} events ≥M2.5"),
        P(Span("STATIONS ", cls="hud-label"), f"{len(PAGASA_STATIONS)} PAGASA"),
        P(Span("TRAIL    ", cls="hud-label"), f"{len(_iss)} pts / 90 min"),
    )


@rt("/api/weather/hud")
async def get():
    cities_wx = await _get_weather()
    cities_aqi = await _get_aqi()
    
    if not cities_wx: return P("Weather unavailable", cls="hud-muted")
    
    # Merge WX and AQI data
    rows = []
    for i, cw in enumerate(cities_wx):
        ca = cities_aqi[i] if cities_aqi and i < len(cities_aqi) else {}
        aqi_val = ca.get('aqi')
        aqi_str = f"AQI {aqi_val}" if aqi_val is not None else "—"
        
        rows.append(
            Tr(
                Td(cw["name"], cls="wx-city"),
                Td(f"{cw['temp']}°C" if cw["temp"] is not None else "—"),
                Td(cw["cond"], cls="wx-cond"),
                Td(aqi_str, cls="wx-aqi"),
            )
        )
        
    return (
        P(Span("WEATHER & AIR QUALITY", cls="hud-label"), cls="hud-title"),
        Table(
            Thead(Tr(Th("CITY"), Th("TEMP"), Th("COND"), Th("AQI"))),
            Tbody(*rows),
            cls="wx-table",
        ),
    )


@rt("/api/disasters/hud")
async def get():
    alerts = await _get_gdacs()
    if not alerts: return P("No critical disaster alerts", cls="hud-muted")
    
    items = []
    for alert in alerts[:5]:  # Top 5 alerts
        items.append(
            Div(
                P(Span(f"[{alert['type']}]", cls=f"ev-tag ev-tag-{alert['severity'].lower()}"), f" {alert['name']}", cls="ev-msg"),
                cls="ev-row",
            )
        )
        
    return (
        P(Span("GLOBAL ALERTS (ORANGE/RED)", cls="hud-label"), cls="hud-title"),
        Div(*items, cls="ev-list"),
    )


@rt("/api/events/feed")
def get():
    if not _events:
        return P("Initializing…", cls="hud-muted")
    items = [
        Div(
            Span(e["ts"],  cls="ev-ts"),
            Span(e["tag"], cls=f"ev-tag ev-tag-{e['tag'].lower()}"),
            Span(e["msg"], cls="ev-msg"),
            cls="ev-row",
        )
        for e in list(_events)[:12]
    ]
    return (
        P(Span("EVENT LOG", cls="hud-label"), cls="hud-title"),
        Div(*items, cls="ev-list"),
    )


# ── Entry point ───────────────────────────────────────────────────────────────

@rt("/api/events/natural/hud")
async def get():
    evs = await _get_natural_events()
    if not evs:
        return P("No active events found", cls="hud-muted")
    CAT_TAG_CLS = {
        "fire":    "ev-tag-fire",
        "storm":   "ev-tag-storm",
        "volcano": "ev-tag-volcano",
        "cryo":    "ev-tag-cryo",
    }
    items = []
    for ev in evs[:10]:
        tag_cls = CAT_TAG_CLS.get(ev["cat"], "")
        items.append(
            Div(
                Span(ev["emoji"], cls=f"ev-tag {tag_cls}"),
                Span(ev["title"][:38], cls="ev-msg"),
                Span(ev["date"], cls="ev-ts"),
                cls="ev-row",
            )
        )
    return (
        P(Span("NATURAL EVENTS", cls="hud-label"), cls="hud-title"),
        Div(*items, cls="ev-list"),
    )


serve(host="0.0.0.0", port=7860)
