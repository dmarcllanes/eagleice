// Shared SVG gradient defs — defined once so all aircraft SVGs can reference them
// without duplicate id conflicts across the DOM
(function() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;');
    svg.innerHTML = `<defs>
      <linearGradient id="ac-body" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#0099cc"/>
        <stop offset="50%" stop-color="#00e5ff"/>
        <stop offset="100%" stop-color="#0099cc"/>
      </linearGradient>
      <linearGradient id="ac-wing" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#007bb5"/>
        <stop offset="100%" stop-color="#004d77"/>
      </linearGradient>
    </defs>`;
    document.body.appendChild(svg);
})();

// Initialize WebGL Globe
const world = Globe()
  (document.getElementById('map'))
  .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
  .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundColor('#020408')
  .pointOfView({ lat: 12.8797, lng: 121.7740, altitude: 2 })
  .showAtmosphere(true)
  .atmosphereColor('#2266ff')
  .atmosphereAltitude(0.25);

// Interaction constraints & animation
world.controls().autoRotate = false;
world.controls().autoRotateSpeed = 1.0;
world.controls().minDistance = 101; // Prevent zooming through the surface
world.controls().maxDistance = 4000;

// Load country borders and labels
fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json')
  .then(res => res.json())
  .then(countries => {
    world.polygonsData(countries.features)
      .polygonCapColor(() => 'rgba(0,0,0,0)')
      .polygonSideColor(() => 'rgba(0,0,0,0)')
      .polygonStrokeColor(() => 'rgba(0, 255, 204, 0.15)') // subtle cyan borders
      .polygonAltitude(0.001)
      .polygonLabel(({ properties: d }) => `
        <div style="background:rgba(5,15,30,0.9);padding:6px 10px;border-radius:4px;border:1px solid #00ffcc;color:#fff;font-family:'Courier New',monospace;font-size:13px;box-shadow:0 0 10px rgba(0,255,204,0.3);">
          <b>${d.name}</b>
        </div>
      `);
  });

// Load major cities
fetch('https://unpkg.com/globe.gl/example/datasets/ne_110m_populated_places_simple.geojson')
  .then(res => res.json())
  .then(places => {
    world.labelsData(places.features)
      .labelLat(d => d.properties.latitude)
      .labelLng(d => d.properties.longitude)
      .labelText(d => d.properties.name)
      .labelSize(d => Math.max(0.4, Math.sqrt(d.properties.pop_max) * 4e-4))
      .labelDotRadius(d => Math.max(0.15, Math.sqrt(d.properties.pop_max) * 1.5e-4))
      .labelColor(() => 'rgba(170, 210, 255, 0.85)')
      .labelResolution(2)
      .labelAltitude(0.002);
  });

// Click info panel
const infoPanel = document.createElement('div');
infoPanel.id = 'info-panel';
infoPanel.style.cssText = 'display:none;position:fixed;bottom:30px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(5,8,16,0.97);border:1px solid #00ffcc;color:#00ffcc;font-family:Courier New,monospace;font-size:14px;padding:16px 22px;border-radius:4px;min-width:320px;max-width:480px;box-shadow:0 0 30px rgba(0,255,204,0.5);line-height:1.8;';
infoPanel.innerHTML = '<div id="info-content"></div><button onclick="this.parentElement.style.display=\'none\'" style="margin-top:10px;width:100%;background:rgba(0,255,204,0.1);border:1px solid #00ffcc;color:#00ffcc;padding:4px;cursor:pointer;font-family:inherit;">✕ CLOSE</button>';
document.body.appendChild(infoPanel);

function showInfo(html) {
    document.getElementById('info-content').innerHTML = html;
    infoPanel.style.display = 'block';
}


// Layer visibilities
let showISS = true;
let showAc  = true;
let showEq  = true;
let showSat = true;
let showWx  = true;
let showSh  = true;

// Data holds
let issHistory = [];
let aircraftData = [];
let prevAircraftData = {};    // id -> {lat, lng}
let acFetchTime = 0;          // timestamp of last aircraft fetch (ms)
const AC_POLL_MS = 10000;     // matches the poll interval
let eqData = [];
let satrecs = [];
let aqiData = [];
let wxData  = [];
let shipData = [];
let alertPulses = [];         // temporary pulse rings from SSE alerts
let timeScrubHours = 0;       // 0 = LIVE
const acTrailMap = {};        // icao → [{lat,lng,alt}] contrail history

// EONET natural event state
let eonetData    = [];
let showFire     = true;
let showStorm    = true;
let showVolcano  = true;
let showCryo     = true;
const eonetElCache = {}; // event id → DOM element

// Layer Toggle function for UI
function toggleLayer(id) {
    const btn = document.getElementById('btn-' + id);
    if (!btn) return;
    
    let isActive = btn.classList.contains('active');
    let displayStyle = isActive ? 'none' : '';
    
    if (isActive) {
        btn.classList.remove('active');
        if (id === 'iss') showISS = false;
        if (id === 'ac')  showAc  = false;
        if (id === 'eq')  showEq  = false;
        if (id === 'sat') { showSat = false; showISS = false; }
        if (id === 'sh')  showSh  = false;
    } else {
        btn.classList.add('active');
        if (id === 'iss') showISS = true;
        if (id === 'ac')  showAc  = true;
        if (id === 'eq')  showEq  = true;
        if (id === 'sat') { showSat = true; showISS = true; }
        if (id === 'sh')  showSh  = true;
    }
    
    if (id === 'iss') document.getElementById('hud-iss').style.display = displayStyle;
    if (id === 'eq')  document.getElementById('hud-disasters').style.display = displayStyle;
    if (id === 'wx')  { showWx = !isActive; document.getElementById('hud-weather').style.display = displayStyle; }
    
    updateLayers();
}

// Imagery discipline tab switcher
function switchImgTab(tab, btn) {
    document.querySelectorAll('.imagery-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.img-tab-panel').forEach(p => p.style.display = 'none');
    const panel = document.getElementById('img-tab-' + tab);
    if (panel) panel.style.display = '';
}

// Natural event category toggle
function toggleEventCategory(cat) {
    const btn = document.getElementById('btn-ev-' + cat);
    if (!btn) return;
    const isActive = btn.classList.contains('active');
    if (isActive) {
        btn.classList.remove('active');
        if (cat === 'fire')    showFire    = false;
        if (cat === 'storm')   showStorm   = false;
        if (cat === 'volcano') showVolcano = false;
        if (cat === 'cryo')    showCryo    = false;
    } else {
        btn.classList.add('active');
        if (cat === 'fire')    showFire    = true;
        if (cat === 'storm')   showStorm   = true;
        if (cat === 'volcano') showVolcano = true;
        if (cat === 'cryo')    showCryo    = true;
    }
    updateLayers();
}

// View Filter Toggle
function setFilter(type, btn) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const mapDiv = document.getElementById('map');
    if (type === 'nvgs') {
        mapDiv.style.filter = 'sepia(100%) hue-rotate(90deg) saturate(300%) contrast(150%) brightness(80%)';
    } else if (type === 'flir') {
        mapDiv.style.filter = 'grayscale(100%) invert(100%) contrast(300%)';
    } else {
        mapDiv.style.filter = 'none';
    }
}

// NASA Worldview imagery switcher
let _nasaBlobUrl     = null;  // current blob URL for NASA layer
let _nasaLayerActive = false; // true when a NASA layer overrides the day/night composite

function setNasaLayer(key, btn) {
    document.querySelectorAll('.nasa-btn').forEach(b => b.classList.remove('active', 'loading'));
    if (btn) btn.classList.add('active');

    if (key === 'default') {
        if (_nasaBlobUrl) { URL.revokeObjectURL(_nasaBlobUrl); _nasaBlobUrl = null; }
        _nasaLayerActive = false;
        updateDayNight(); // restore day/night composite
        return;
    }

    _nasaLayerActive = true;
    if (btn) btn.classList.add('loading');
    fetch(`/api/nasa/globe?layer=${key}`)
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const ct = r.headers.get('content-type') || '';
            if (!ct.startsWith('image')) throw new Error(`Not image: ${ct}`);
            return r.blob();
        })
        .then(blob => {
            if (_nasaBlobUrl) URL.revokeObjectURL(_nasaBlobUrl);
            _nasaBlobUrl = URL.createObjectURL(blob);
            world.globeImageUrl(_nasaBlobUrl);
            if (btn) btn.classList.remove('loading');
        })
        .catch(() => {
            _nasaLayerActive = false;
            if (btn) {
                btn.classList.remove('loading', 'active');
                btn.style.color = '#ff4444';
                setTimeout(() => { btn.style.color = ''; }, 2500);
            }
        });
}

// ── Day/Night Composite Texture ───────────────────────────────────────────────
// Strategy: preload a daytime Earth texture + the existing city-lights texture.
// Each minute, draw the day texture as the globe base, then clip-draw the
// city-lights texture over the night hemisphere using the Canvas 2D API.
// The resulting canvas is passed to world.globeImageUrl() as a blob URL.

let _sunData       = null;   // { lat, lng } current subsolar point
let _sunEl         = null;   // cached ☀️ DOM element
let _terminatorPts = [];     // [{lat,lng,alt}] for the visible terminator path line
let _dnBlobUrl     = null;   // current blob URL for the composited texture

const _dayImg   = new Image();
const _nightImg = new Image();
let _dayLoaded   = false;
let _nightLoaded = false;
let _dnCanvas    = null;
let _dnCtx       = null;

_dayImg.crossOrigin   = 'anonymous';
_nightImg.crossOrigin = 'anonymous';
_dayImg.onload   = () => { _dayLoaded   = true; if (_nightLoaded && _sunData) _renderDNTexture(); };
_nightImg.onload = () => { _nightLoaded = true; if (_dayLoaded   && _sunData) _renderDNTexture(); };
_dayImg.src   = '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg';
_nightImg.src = '//unpkg.com/three-globe/example/img/earth-night.jpg';

function _computeSunPosition() {
    const now = new Date();
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    const declDeg   = 23.45 * Math.sin(2 * Math.PI / 365 * (dayOfYear - 81));
    const utcH      = now.getUTCHours() + now.getUTCMinutes()/60 + now.getUTCSeconds()/3600;
    return { lat: declDeg, lng: ((-(utcH - 12) * 15) + 540) % 360 - 180 };
}

// Longitude-sweep: tan(terminatorLat) = -cos(Δlng) / tan(sunLat)
// Gives the latitude of the solar terminator at each longitude.
function _computeTerminatorPts(sunLat, sunLng) {
    const sunLatR = sunLat * Math.PI / 180;
    const sunLngR = sunLng * Math.PI / 180;
    // Clamp near equinox to avoid tan→0 division
    const sLat = Math.abs(sunLatR) < 0.017 ? (sunLatR >= 0 ? 0.017 : -0.017) : sunLatR;
    const pts = [];
    for (let i = 0; i <= 360; i++) {
        const lng  = -180 + i;
        const dLng = lng * Math.PI / 180 - sunLngR;
        const lat  = Math.atan(-Math.cos(dLng) / Math.tan(sLat)) * 180 / Math.PI;
        pts.push({ lat, lng, alt: 0.006 });
    }
    _terminatorPts = pts;
}

// Draw day texture on full canvas, then clip-draw the city-lights texture
// over the night hemisphere polygon (area below/above the terminator curve).
function _renderDNTexture() {
    if (!_dayLoaded || !_nightLoaded || !_sunData || !_terminatorPts.length) return;

    if (!_dnCanvas) {
        _dnCanvas = document.createElement('canvas');
        _dnCanvas.width  = 4096;
        _dnCanvas.height = 2048;
        _dnCtx = _dnCanvas.getContext('2d');
    }
    const ctx = _dnCtx;
    const W = 4096, H = 2048;

    // 1. Daytime base
    ctx.drawImage(_dayImg, 0, 0, W, H);

    // 2. Build night-side clip polygon in canvas (equirectangular) space.
    //    For sunLat > 0: night is below terminator (toward south pole, y=H).
    //    For sunLat < 0: night is above terminator (toward north pole, y=0).
    const poleY = _sunData.lat >= 0 ? H : 0;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, poleY);
    ctx.lineTo(0, (90 - _terminatorPts[0].lat) / 180 * H);
    for (const { lat, lng } of _terminatorPts) {
        ctx.lineTo((lng + 180) / 360 * W, (90 - lat) / 180 * H);
    }
    ctx.lineTo(W, poleY);
    ctx.closePath();
    ctx.clip();

    // 3. City-lights texture on the night side
    ctx.drawImage(_nightImg, 0, 0, W, H);
    ctx.restore();

    // 4. Upload to Globe.gl via async blob (non-blocking)
    _dnCanvas.toBlob(blob => {
        if (!blob) return;
        if (_dnBlobUrl) URL.revokeObjectURL(_dnBlobUrl);
        _dnBlobUrl = URL.createObjectURL(blob);
        world.globeImageUrl(_dnBlobUrl);
    }, 'image/jpeg', 0.88);
}

function updateDayNight() {
    if (_nasaLayerActive) return;
    _sunData = _computeSunPosition();
    _computeTerminatorPts(_sunData.lat, _sunData.lng);
    _renderDNTexture();
    scheduleGlobeUpdate(); // refresh terminator path line + sun icon position
}

function _getSunEl() {
    if (!_sunEl) {
        _sunEl = document.createElement('div');
        _sunEl.style.cssText =
            'font-size:20px;pointer-events:none;line-height:1;' +
            'filter:drop-shadow(0 0 14px #ffee00) drop-shadow(0 0 6px #ff8800);';
        _sunEl.textContent = '☀️';
    }
    return _sunEl;
}

// Draw the data onto the 4D Globe
// Element caches: keyed by icao/sat name so we reuse the same DOM node every frame
// This is critical—recreating elements every 120ms destroys mouseenter listeners
const acElCache      = {};  // keyed by icao
const satElCache     = {};  // keyed by satellite name
const eqElCache      = {};  // keyed by event time
const wxElCache      = {};  // keyed by 'station_<name>' — weather+AQI merged badge
const shElCache      = {};  // keyed by mmsi

function updateLayers() {
    // 1. HTML Icons — Aircraft (✈) and Satellites (🛰) 
    const htmlObjects = [];
    if (showAc) {
        const now = Date.now();
        const t = Math.min((now - acFetchTime) / AC_POLL_MS, 1);
        for (const d of aircraftData) {
            const prev = prevAircraftData[d.icao];
            const lat = prev ? prev.lat + (d.lat - prev.lat) * t : d.lat;
            const lng = prev ? prev.lng + (d.lng - prev.lng) * t : d.lng;
            
            // Military tactical track symbol — triangle + data tag
            if (!acElCache[d.icao]) {
                const el = document.createElement('div');
                el.className = 'ac-track';
                // wrapper keeps pointer-events isolated; rotation applied by fastFrame
                // Use pointer-events:none on wrapper to allow globe zoom/scroll to pass through
                el.style.cssText = 'position:relative;cursor:pointer;pointer-events:none;width:0;height:0;';
                el.innerHTML = `
                  <svg class="ac-sym" viewBox="-12 -12 24 24" width="18" height="18"
                       xmlns="http://www.w3.org/2000/svg" style="position:absolute;top:-9px;left:-9px;overflow:visible;pointer-events:none;">
                    <!-- Airplane shape -->
                    <path d="M 0,-10 C 2,-10 2,-8 2,-7 L 2,-2 L 10,2 L 10,4 L 2,2 L 2,6 L 5,8 L 5,10 L 0,9 L -5,10 L -5,8 L -2,6 L -2,2 L -10,4 L -10,2 L -2,-2 L -2,-7 C -2,-8 -2,-10 0,-10 Z"
                          fill="rgba(0,230,255,0.9)" stroke="#00ffff" stroke-width="1"
                          style="filter:drop-shadow(0 0 4px #00ffff); pointer-events:all;"/>
                  </svg>`;
                const icao = d.icao;
                const acInfo = () => {
                    const live = aircraftData.find(x => x.icao === icao) || {};
                    const altFt = live.alt || 0;
                    const altBand = altFt > 25000 ? 'HIGH CRUISE' : altFt > 10000 ? 'CLIMBING' : 'LOW ALT';
                    showInfo(
                        `<div style="font-weight:bold;font-size:15px;margin-bottom:8px;border-bottom:1px solid #00ffcc;padding-bottom:4px;">▲ ${live.call || icao}</div>` +
                        `<div><span style="color:#888">ICAO:</span>     ${icao}</div>` +
                        `<div><span style="color:#888">ALTITUDE:</span> ${altFt.toLocaleString()} ft · ${altBand}</div>` +
                        `<div><span style="color:#888">SPEED:</span>    ${live.vel || 0} km/h</div>` +
                        `<div><span style="color:#888">HEADING:</span>  ${live.hdg || 0}°</div>` +
                        `<div><span style="color:#888">POSITION:</span> ${(live.lat||0).toFixed(4)}°N ${(live.lng||0).toFixed(4)}°E</div>`
                    );
                };
                el.addEventListener('click', (e) => { e.stopPropagation(); acInfo(); });
                acElCache[d.icao] = el;
            }
            // Style (transform/filter) is handled by fastFrame rAF loop — no work here
            const alt = d.alt || 0;
            const acAlt = Math.min(alt / 20000, 0.4);
            htmlObjects.push({ lat, lng, alt: acAlt, el: acElCache[d.icao] });

            // Accumulate contrail trail (capped at 40 points ≈ 2 seconds at 20fps)
            if (!acTrailMap[d.icao]) acTrailMap[d.icao] = [];
            acTrailMap[d.icao].push({ lat, lng, alt: acAlt });
            if (acTrailMap[d.icao].length > 40) acTrailMap[d.icao].shift();
        }
    }
    const satLines = [];
    if (showSat && satrecs.length > 0) {
        const now = new Date();
        const gmst = satellite.gstime(now);
        for (const sat of satrecs) {
            const pv = satellite.propagate(sat.satrec, now);
            if (!pv.position) continue;
            const gd = satellite.eciToGeodetic(pv.position, gmst);
            const lat = satellite.degreesLat(gd.latitude);
            const lng = satellite.degreesLong(gd.longitude);
            const alt = gd.height / 6371;
            if (!isNaN(lat) && !isNaN(lng)) {
                if (!satElCache[sat.name]) {
                    const el = document.createElement('div');
                    el.style.cssText = 'position:relative;width:0;height:0;pointer-events:none;';
                    const isISS = sat.name.includes('ISS') || sat.name.includes('ZARYA');
                    const innerCss = 'position:absolute;transform:translate(-50%, -50%);display:flex;flex-direction:column;align-items:center;pointer-events:auto;cursor:pointer;';
                    
                    if (isISS) {
                        el.innerHTML = `<div class="globe-icon iss-icon" style="${innerCss}">
                          <svg viewBox="0 0 72 30" width="64" height="26" xmlns="http://www.w3.org/2000/svg">
                            <defs>
                              <linearGradient id="iss-truss" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stop-color="#e8e8e8"/>
                                <stop offset="50%" stop-color="#ffffff"/>
                                <stop offset="100%" stop-color="#aaaaaa"/>
                              </linearGradient>
                              <linearGradient id="iss-mod" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="#fff8d0"/>
                                <stop offset="100%" stop-color="#d4a800"/>
                              </linearGradient>
                              <linearGradient id="iss-sol" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stop-color="#1a4499"/>
                                <stop offset="100%" stop-color="#0a1f55"/>
                              </linearGradient>
                            </defs>

                            <!-- Integrated Truss Structure -->
                            <rect x="0" y="13" width="72" height="4" fill="url(#iss-truss)" stroke="#999" stroke-width="0.4" rx="0.5"/>
                            <line x1="9"  y1="13" x2="9"  y2="17" stroke="#ccc" stroke-width="0.4"/>
                            <line x1="18" y1="13" x2="18" y2="17" stroke="#ccc" stroke-width="0.4"/>
                            <line x1="27" y1="13" x2="27" y2="17" stroke="#ccc" stroke-width="0.4"/>
                            <line x1="45" y1="13" x2="45" y2="17" stroke="#ccc" stroke-width="0.4"/>
                            <line x1="54" y1="13" x2="54" y2="17" stroke="#ccc" stroke-width="0.4"/>
                            <line x1="63" y1="13" x2="63" y2="17" stroke="#ccc" stroke-width="0.4"/>

                            <!-- P6 solar arrays (far left) -->
                            <rect x="1"  y="4"  width="16" height="5" fill="url(#iss-sol)" stroke="#4488cc" stroke-width="0.6" rx="0.3"/>
                            <line x1="5"  y1="4" x2="5"  y2="9" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="9"  y1="4" x2="9"  y2="9" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="13" y1="4" x2="13" y2="9" stroke="#5599ee" stroke-width="0.4"/>
                            <rect x="1"  y="21" width="16" height="5" fill="url(#iss-sol)" stroke="#4488cc" stroke-width="0.6" rx="0.3"/>
                            <line x1="5"  y1="21" x2="5"  y2="26" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="9"  y1="21" x2="9"  y2="26" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="13" y1="21" x2="13" y2="26" stroke="#5599ee" stroke-width="0.4"/>

                            <!-- P4 solar arrays -->
                            <rect x="19" y="2"  width="16" height="5" fill="url(#iss-sol)" stroke="#4488cc" stroke-width="0.6" rx="0.3"/>
                            <line x1="23" y1="2" x2="23" y2="7" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="27" y1="2" x2="27" y2="7" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="31" y1="2" x2="31" y2="7" stroke="#5599ee" stroke-width="0.4"/>
                            <rect x="19" y="23" width="16" height="5" fill="url(#iss-sol)" stroke="#4488cc" stroke-width="0.6" rx="0.3"/>
                            <line x1="23" y1="23" x2="23" y2="28" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="27" y1="23" x2="27" y2="28" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="31" y1="23" x2="31" y2="28" stroke="#5599ee" stroke-width="0.4"/>

                            <!-- S4 solar arrays -->
                            <rect x="37" y="2"  width="16" height="5" fill="url(#iss-sol)" stroke="#4488cc" stroke-width="0.6" rx="0.3"/>
                            <line x1="41" y1="2" x2="41" y2="7" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="45" y1="2" x2="45" y2="7" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="49" y1="2" x2="49" y2="7" stroke="#5599ee" stroke-width="0.4"/>
                            <rect x="37" y="23" width="16" height="5" fill="url(#iss-sol)" stroke="#4488cc" stroke-width="0.6" rx="0.3"/>
                            <line x1="41" y1="23" x2="41" y2="28" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="45" y1="23" x2="45" y2="28" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="49" y1="23" x2="49" y2="28" stroke="#5599ee" stroke-width="0.4"/>

                            <!-- S6 solar arrays (far right) -->
                            <rect x="55" y="4"  width="16" height="5" fill="url(#iss-sol)" stroke="#4488cc" stroke-width="0.6" rx="0.3"/>
                            <line x1="59" y1="4" x2="59" y2="9" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="63" y1="4" x2="63" y2="9" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="67" y1="4" x2="67" y2="9" stroke="#5599ee" stroke-width="0.4"/>
                            <rect x="55" y="21" width="16" height="5" fill="url(#iss-sol)" stroke="#4488cc" stroke-width="0.6" rx="0.3"/>
                            <line x1="59" y1="21" x2="59" y2="26" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="63" y1="21" x2="63" y2="26" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="67" y1="21" x2="67" y2="26" stroke="#5599ee" stroke-width="0.4"/>

                            <!-- Central hab module cluster -->
                            <rect x="29" y="9" width="14" height="12" rx="2" fill="url(#iss-mod)" stroke="#ccaa00" stroke-width="0.8"/>
                            <line x1="33" y1="9" x2="33" y2="21" stroke="#ccaa00" stroke-width="0.4" opacity="0.6"/>
                            <line x1="37" y1="9" x2="37" y2="21" stroke="#ccaa00" stroke-width="0.4" opacity="0.6"/>
                            <line x1="41" y1="9" x2="41" y2="21" stroke="#ccaa00" stroke-width="0.4" opacity="0.6"/>
                          </svg>
                          <span class="sat-label iss-label">ISS</span>
                        </div>`;
                    } else {
                        el.innerHTML = `<div class="globe-icon sat-icon" style="${innerCss}">
                          <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
                            <!-- Hexagonal body -->
                            <polygon points="12,3 17,6.5 17,13.5 12,17 7,13.5 7,6.5"
                                     fill="#1a0530" stroke="#cc44ff" stroke-width="0.9"/>
                            <!-- Inner glow panel -->
                            <polygon points="12,5.5 15.5,7.5 15.5,12.5 12,14.5 8.5,12.5 8.5,7.5"
                                     fill="#2d0a4a" stroke="#aa33dd" stroke-width="0.5" opacity="0.8"/>
                            <!-- Center core -->
                            <circle cx="12" cy="10" r="2.2" fill="#ee88ff" stroke="#cc44ff" stroke-width="0.6"/>
                            <circle cx="12" cy="10" r="1"   fill="#ffffff" opacity="0.9"/>
                            <!-- Left solar panel with cell lines -->
                            <rect x="0" y="8" width="6" height="4" rx="0.3" fill="#0d2060" stroke="#4488cc" stroke-width="0.6"/>
                            <line x1="2" y1="8" x2="2" y2="12" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="4" y1="8" x2="4" y2="12" stroke="#5599ee" stroke-width="0.4"/>
                            <!-- Panel arm left -->
                            <line x1="6" y1="10" x2="7" y2="10" stroke="#cc44ff" stroke-width="0.8"/>
                            <!-- Right solar panel -->
                            <rect x="18" y="8" width="6" height="4" rx="0.3" fill="#0d2060" stroke="#4488cc" stroke-width="0.6"/>
                            <line x1="20" y1="8" x2="20" y2="12" stroke="#5599ee" stroke-width="0.4"/>
                            <line x1="22" y1="8" x2="22" y2="12" stroke="#5599ee" stroke-width="0.4"/>
                            <!-- Panel arm right -->
                            <line x1="17" y1="10" x2="18" y2="10" stroke="#cc44ff" stroke-width="0.8"/>
                            <!-- Antenna mast -->
                            <line x1="12" y1="3" x2="12" y2="0.5" stroke="#dd66ff" stroke-width="0.7"/>
                            <circle cx="12" cy="0.5" r="1" fill="#ff44ff" stroke="#dd00ff" stroke-width="0.4"/>
                          </svg>
                        </div>`;
                    }

                    const capturedName = sat.name;
                    const satInfo = () => {
                        const pv2 = satellite.propagate(sat.satrec, new Date());
                        const gmst2 = satellite.gstime(new Date());
                        const gd2 = satellite.eciToGeodetic(pv2.position, gmst2);
                        const latD = satellite.degreesLat(gd2.latitude).toFixed(4);
                        const lngD = satellite.degreesLong(gd2.longitude).toFixed(4);
                        const altKm = (gd2.height).toFixed(1);
                        const color = isISS ? '#ffcc00' : '#cc44ff';
                        showInfo(
                            `<div style="font-weight:bold;font-size:15px;margin-bottom:8px;border-bottom:1px solid ${color};padding-bottom:4px;color:${color};">${isISS ? '🛸 ' : ''}${capturedName}</div>` +
                            `<div><span style="color:#888">Altitude:</span>  ${altKm} km</div>` +
                            `<div><span style="color:#888">Position:</span>  ${latD}°N, ${lngD}°E</div>`
                        );
                    };
                    el.addEventListener('click', (e) => { e.stopPropagation(); satInfo(); });
                    satElCache[sat.name] = el;
                }
                const satAlt = Math.max(alt * 0.2, 0.05);
                htmlObjects.push({ lat, lng, alt: satAlt, el: satElCache[sat.name] });
                
                // Vertical line pointing exactly to the land/surface location
                satLines.push({ type: 'sat', coords: [{lat, lng, alt: satAlt}, {lat, lng, alt: 0}] });
            }
        }
    }
    // 1b. Earthquake epicenter click markers (depth → altitude)
    const eqHtml = [];
    if (showEq) {
        for (const eq of eqData) {
            const key = eq.time;
            if (!eqElCache[key]) {
                const el = document.createElement('div');
                el.style.cssText = `position:relative;width:0;height:0;pointer-events:none;`;
                const emojiFontSize = eq.mag > 5 ? 20 : 15;
                const emoji = eq.mag >= 6 ? '🔴' : eq.mag >= 4 ? '🟠' : '🟡';
                el.innerHTML = `<div style="position:absolute;transform:translate(-50%,-50%);font-size:${emojiFontSize}px;cursor:pointer;pointer-events:auto;filter:drop-shadow(0 0 6px rgba(255,60,0,0.9));line-height:1;display:flex;align-items:center;justify-content:center;">${emoji}</div>`;
                el.querySelector('div').addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const d = eqData.find(x => x.time === key) || eq;
                    showInfo(
                        `<div style="font-weight:bold;font-size:15px;margin-bottom:8px;border-bottom:1px solid #ff4400;padding-bottom:4px;color:#ff6600;">🌍 M${d.mag} Earthquake</div>` +
                        `<div><span style="color:#888">Location:</span>  ${d.place}</div>` +
                        `<div><span style="color:#888">Magnitude:</span> M${d.mag}</div>` +
                        `<div><span style="color:#888">Depth:</span>     ${d.depth} km</div>` +
                        `<div><span style="color:#888">Position:</span>  ${d.lat.toFixed(3)}°N, ${d.lng.toFixed(3)}°E</div>` +
                        `<div><span style="color:#888">Time (PHT):</span> ${new Date(d.time).toLocaleString('en-PH', {timeZone:'Asia/Manila'})}</div>` +
                        `<div style="margin-top:6px;font-size:9px;color:#555;letter-spacing:1px;">SOURCE: PHIVOLCS / DOST</div>`
                    );
                });
                eqElCache[key] = el;
            }
            // Map depth (km) to globe altitude so deep quakes visually sink below the surface

            const depthAlt = 0.005 + Math.min((eq.depth || 0) / 2000, 0.25);
            eqHtml.push({ lat: eq.lat, lng: eq.lng, alt: depthAlt, el: eqElCache[key] });
        }
    }

    // 1c. PAGASA station badges — weather + AQI merged into one marker per station
    const stationHtml = [];
    if (showWx) {
        const COND_ICON = {
            'Clear':'☀️','Mainly Clear':'🌤️','Partly Cloudy':'⛅','Overcast':'☁️',
            'Fog':'🌫️','Icy Fog':'🌫️','Lt Drizzle':'🌦️','Drizzle':'🌧️',
            'Hvy Drizzle':'🌧️','Lt Rain':'🌧️','Rain':'🌧️','Hvy Rain':'🌧️',
            'Showers':'🌦️','Rain Showers':'🌦️','Violent Showers':'⛈️',
            'Thunderstorm':'⛈️','TS + Hail':'⛈️','Severe TS':'🌪️',
        };
        // Build lookup maps for fast merging
        const wxMap  = Object.fromEntries(wxData.map(w => [w.name, w]));
        const aqiMap = Object.fromEntries(aqiData.map(a => [a.name, a]));

        // Use whichever dataset has station names; prefer wxData since it always has lat/lng
        const stationNames = wxData.length
            ? wxData.map(w => w.name)
            : aqiData.map(a => a.name);

        for (const name of stationNames) {
            const wx  = wxMap[name];
            const aqi = aqiMap[name];
            if (!wx && !aqi) continue;

            const key = 'station_' + name;
            const temp    = wx?.temp  != null ? Math.round(wx.temp)  : null;
            const cond    = wx?.cond  ?? '—';
            const aqiVal  = aqi?.aqi  ?? null;
            const sig     = `${temp}|${cond}|${aqiVal}`;

            if (!wxElCache[key] || wxElCache[key]._sig !== sig) {
                const icon = COND_ICON[cond] || '🌡️';
                const aqiColor = aqiVal == null ? '#888'
                    : aqiVal >= 150 ? '#ff4444'
                    : aqiVal >= 100 ? '#ff8800'
                    : aqiVal >= 50  ? '#ffcc00' : '#00dd77';

                const el = document.createElement('div');
                el.style.cssText = `position:relative;width:0;height:0;pointer-events:none;`;
                el.innerHTML = `<div style="position:absolute;transform:translate(-50%,-50%);font-size:18px;cursor:pointer;pointer-events:auto;filter:drop-shadow(0 0 6px ${aqiColor});line-height:1;display:flex;align-items:center;justify-content:center;">${icon}</div>`;

                el._sig = sig;
                el.querySelector('div').addEventListener('click', (e) => {
                    e.stopPropagation();
                    showInfo(
                        `<div style="font-weight:bold;font-size:15px;margin-bottom:8px;border-bottom:1px solid ${aqiColor};padding-bottom:4px;color:#77aaff;">${icon} ${name} — PAGASA Station</div>` +
                        `<div><span style="color:#888">Condition:</span>   ${cond}</div>` +
                        `<div><span style="color:#888">Temperature:</span> ${temp != null ? temp + '°C' : '—'}</div>` +
                        `<div><span style="color:#888">Wind:</span>        ${wx?.wind ?? '—'} km/h</div>` +
                        `<div><span style="color:#888">Rainfall:</span>    ${wx?.rain ?? 0} mm</div>` +
                        (aqiVal != null
                            ? `<div><span style="color:#888">AQI (EU):</span>    <span style="color:${aqiColor}">${aqiVal}</span></div>` +
                              `<div><span style="color:#888">PM2.5:</span>       ${aqi?.pm25 ?? '—'} µg/m³</div>` +
                              `<div><span style="color:#888">PM10:</span>        ${aqi?.pm10 ?? '—'} µg/m³</div>`
                            : '') +
                        `<div style="margin-top:6px;font-size:9px;color:#555;letter-spacing:1px;">SOURCE: OPEN-METEO / PAGASA</div>`
                    );
                });
                wxElCache[key] = el;
            }
            const lat = wx?.lat ?? aqi?.lat;
            const lng = wx?.lng ?? aqi?.lng;
            if (lat && lng) stationHtml.push({ lat, lng, alt: 0.02, el: wxElCache[key] });
        }
    }

    // 1e. Ship vessel markers
    const shHtml = [];
    if (showSh) {
        for (const sh of shipData) {
            const key = sh.mmsi || sh.name;
            if (!shElCache[key]) {
                const el = document.createElement('div');
                el.style.cssText = 'position:relative;width:0;height:0;pointer-events:none;transition:transform 0.3s linear;';
                el.innerHTML = `
                  <div style="position:absolute;transform:translate(-50%,-50%);cursor:pointer;pointer-events:auto;display:flex;align-items:center;justify-content:center;">
                    <svg viewBox="0 0 14 22" width="13" height="20" xmlns="http://www.w3.org/2000/svg">
                      <!-- Hull — pointed bow at top -->
                    <path d="M7,1 C9,3 10,8 10,14 C10,18 9,20 7,21 C5,20 4,18 4,14 C4,8 5,3 7,1 Z"
                          fill="#3a8fa8" stroke="#77ccee" stroke-width="0.7"/>
                    <!-- Superstructure / bridge -->
                    <rect x="4.5" y="9" width="5" height="5" rx="0.6"
                          fill="#1a3a4a" stroke="#2266aa" stroke-width="0.5"/>
                    <!-- Mast center line -->
                    <line x1="7" y1="5" x2="7" y2="9" stroke="#88bbcc" stroke-width="0.5"/>
                    <!-- Bow dot -->
                    <circle cx="7" cy="1.5" r="1.2" fill="#ffffff" stroke="#aaddff" stroke-width="0.4"/>
                  </svg>`;
                const capturedSh = sh;
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const live = shipData.find(x => (x.mmsi || x.name) === key) || capturedSh;
                    showInfo(
                        `<div style="font-weight:bold;font-size:15px;margin-bottom:8px;border-bottom:1px solid #77ccee;padding-bottom:4px;color:#77ccee;">⚓ ${live.name || 'UNKNOWN'}</div>` +
                        `<div><span style="color:#888">MMSI:</span>   ${live.mmsi || '—'}</div>` +
                        `<div><span style="color:#888">Type:</span>   ${live.type || '—'}</div>` +
                        `<div><span style="color:#888">Speed:</span>  ${live.speed || 0} kn</div>` +
                        `<div><span style="color:#888">Heading:</span>${live.hdg || 0}°</div>` +
                        `<div><span style="color:#888">Dest:</span>   ${live.dest || '—'}</div>` +
                        `<div><span style="color:#888">Pos:</span>    ${(live.lat||0).toFixed(3)}°N, ${(live.lng||0).toFixed(3)}°E</div>`
                    );
                });
                shElCache[key] = el;
            }
            shElCache[key].style.transform = `rotate(${sh.hdg || 0}deg)`;
            shHtml.push({ lat: sh.lat, lng: sh.lng, alt: 0, el: shElCache[key] });
        }
    }

    // Sun sub-solar marker
    const sunHtml = (_sunData) ? [{ lat: _sunData.lat, lng: _sunData.lng, alt: 0.02, el: _getSunEl() }] : [];

    // 1d. EONET natural event markers
    const eonetHtml = [];
    const CAT_VISIBLE = { fire: showFire, storm: showStorm, volcano: showVolcano, cryo: showCryo };
    const CAT_COLOR   = { fire: '#ff6600', storm: '#00aaff', volcano: '#ff2200', cryo: '#00ddff' };
    for (const ev of eonetData) {
        if (!CAT_VISIBLE[ev.cat]) continue;
        const key = ev.id;
        if (!eonetElCache[key]) {
            const el = document.createElement('div');
            const color = CAT_COLOR[ev.cat] || '#ffffff';
            el.style.cssText = `position:relative;width:0;height:0;pointer-events:none;`;
            el.innerHTML = `<div style="position:absolute;transform:translate(-50%,-50%);font-size:18px;cursor:pointer;pointer-events:auto;filter:drop-shadow(0 0 8px ${color});line-height:1;display:flex;align-items:center;justify-content:center;">${ev.emoji}</div>`;
            el.querySelector('div').addEventListener('click', (e) => {
                e.stopPropagation();
                showInfo(
                    `<div style="font-weight:bold;font-size:15px;margin-bottom:8px;border-bottom:1px solid ${color};padding-bottom:4px;color:${color};">` +
                    `${ev.emoji} ${ev.title}</div>` +
                    `<div><span style="color:#888">Category:</span>  ${ev.label}</div>` +
                    `<div><span style="color:#888">Date:</span>      ${ev.date}</div>` +
                    `<div><span style="color:#888">Position:</span>  ${ev.lat.toFixed(3)}°N, ${ev.lng.toFixed(3)}°E</div>` +
                    (ev.link ? `<div style="margin-top:6px"><a href="${ev.link}" target="_blank" style="color:${color};text-decoration:none;font-size:10px;"` +
                    ` >⇒ VIEW SOURCE</a></div>` : '') +
                    `<div style="margin-top:6px;font-size:9px;color:#555;letter-spacing:1px;">SOURCE: NASA EONET</div>`
                );
            });
            eonetElCache[key] = el;
        }
        eonetHtml.push({ lat: ev.lat, lng: ev.lng, alt: 0.01, el: eonetElCache[key] });
    }

    // Single final htmlElementsData call — merges all layers
    world.htmlElementsData([...htmlObjects, ...eqHtml, ...stationHtml, ...shHtml, ...eonetHtml, ...sunHtml])
         .htmlLat(d => d.lat)
         .htmlLng(d => d.lng)
         .htmlAltitude(d => d.alt)
         .htmlElement(d => d.el);

    // 2. Earthquakes rings + temporary alert pulses
    const allRings = [
        ...(showEq ? eqData : []),
        ...alertPulses,
    ];
    world.ringsData(allRings)
         .ringLat(d => d.lat)
         .ringLng(d => d.lng)
         .ringColor(d => d._pulse ? () => '#ff0000' : () => d.mag > 5 ? '#ff0000' : '#ffaa00')
         .ringMaxRadius(d => d._pulse ? 6 : d.mag * 0.5)
         .ringPropagationSpeed(d => d._pulse ? 3 : d.mag * 0.2)
         .ringRepeatPeriod(d => d._pulse ? 800 : 2000)
         .ringLabel(d => d._pulse ? '⚠ ALERT' : `M${d.mag} Earthquake<br>${d.place}`);
         
    // 3. Paths (ISS Trail + Satellite Ground Lines + Aircraft Contrails + Terminator)
    const paths = [];
    if (showISS && issHistory.length > 0) {
        paths.push({ type: 'iss', coords: issHistory });
    }
    if (showSat && satLines.length > 0) {
        paths.push(...satLines);
    }
    if (showAc) {
        for (const [, pts] of Object.entries(acTrailMap)) {
            if (pts.length >= 2) paths.push({ type: 'ac-trail', coords: pts });
        }
    }
    // Solar terminator line — always rendered when sun position is known
    if (_terminatorPts.length > 0) {
        paths.push({ type: 'terminator', coords: _terminatorPts });
    }
    world.pathsData(paths)
         .pathPoints('coords')
         .pathPointLat(p => p.lat)
         .pathPointLng(p => p.lng)
         .pathPointAlt(p => p.alt !== undefined ? p.alt : 0.05)
         .pathColor(d => {
             if (d.type === 'iss')        return ['rgba(255,255,255,0)',   'rgba(255,255,255,0.85)'];
             if (d.type === 'ac-trail')   return ['rgba(0,200,255,0)',     'rgba(0,200,255,0.55)'];
             if (d.type === 'terminator') return ['rgba(255,200,60,0.9)',  'rgba(255,200,60,0.9)'];
             return                              ['rgba(0,255,204,0.05)',  'rgba(0,255,204,0.8)'];
         })
         .pathStroke(d => d.type === 'iss' ? 2 : d.type === 'terminator' ? 1.5 : d.type === 'ac-trail' ? 0.8 : 1)
         .pathDashLength(d => d.type === 'iss' ? 0.01 : d.type === 'terminator' ? 0.015 : 1)
         .pathDashGap(d => d.type === 'iss' ? 0.005 : d.type === 'terminator' ? 0.008 : 0)
         .pathDashAnimateTime(d => d.type === 'iss' ? 5000 : 0);

    // 4. Labels (ISS current tracking)
    const labels = [];
    if (showISS && issHistory.length > 0) {
        const currentLoc = issHistory[issHistory.length - 1];
        labels.push({ ...currentLoc, name: 'ISS (ZARYA)', isISS: true });
    }
    
    world.labelsData(labels)
         .labelLat(d => d.lat)
         .labelLng(d => d.lng)
         .labelAltitude(0.05)
         .labelDotRadius(0.3)
         .labelDotOrientation('right')
         .labelColor(() => '#ffffff')
         .labelText(() => 'ISS')
         .labelSize(1.5)
         .labelLabel(() => 'International Space Station');
}

// Network Fetching Logic
async function fetchISS() {
    try {
        const res = await fetch('/api/iss/trail');
        if (!res.ok) return;
        issHistory = await res.json();
        updateLayers();
    } catch (e) {}
}

async function fetchAircraft() {
    try {
        const res = await fetch('/api/aircraft');
        if (!res.ok) return;
        const newData = await res.json();
        // Snapshot current positions as previous before replacing
        prevAircraftData = {};
        for (const d of aircraftData) {
            prevAircraftData[d.icao] = { lat: d.lat, lng: d.lng };
        }
        aircraftData = newData;
        acFetchTime = Date.now();
        scheduleGlobeUpdate();
    } catch (e) {}
}

async function fetchEarthquakes() {
    if (timeScrubHours !== 0) return; // don't overwrite scrubbed view
    try {
        const res = await fetch('/api/earthquakes');
        if (!res.ok) return;
        eqData = await res.json();
        updateLayers();
    } catch (e) {}
}

async function fetchAQI() {
    try {
        const res = await fetch('/api/aqi');
        if (!res.ok) return;
        aqiData = await res.json();
        updateLayers();
    } catch (e) {}
}

async function fetchWeather() {
    try {
        const res = await fetch('/api/weather');
        if (!res.ok) return;
        wxData = await res.json();
        updateLayers();
    } catch (e) {}
}

async function fetchShips() {
    try {
        const res = await fetch('/api/ships');
        if (!res.ok) return;
        shipData = await res.json();
        updateLayers();
    } catch (e) {}
}

async function fetchSatellites() {
    try {
        const res = await fetch('/api/satellites/tle');
        if (!res.ok) return;
        const text = await res.text();
        const lines = text.split('\n');
        satrecs = [];
        // Celestrak TLEs are 3 lines: Name, Line1, Line2
        for (let i = 0; i < lines.length - 2; i += 3) {
            const name = lines[i].trim();
            const tle1 = lines[i+1].trim();
            const tle2 = lines[i+2].trim();
            if (name && tle1 && tle2) {
                try {
                    const satrec = satellite.twoline2satrec(tle1, tle2);
                    satrecs.push({ name, satrec });
                } catch(e) {}
            }
        }
        updateLayers();
    } catch (e) {}
}

async function fetchNaturalEvents() {
    try {
        const res = await fetch('/api/events/natural');
        if (!res.ok) return;
        eonetData = await res.json();
        updateLayers();
    } catch (e) {}
}

let _resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
        world.width(window.innerWidth).height(window.innerHeight);
    }, 100);
});

// ── SSE Alert Stream ───────────────────────────────────────────────────────────
const alertBanner = document.getElementById('alert-banner');
let alertHideTimer = null;

function triggerAlertPulse(lat, lng) {
    const pulse = { lat, lng, _pulse: true };
    alertPulses.push(pulse);
    setTimeout(() => {
        alertPulses = alertPulses.filter(p => p !== pulse);
        updateLayers();
    }, 8000);
}

const alertSource = new EventSource('/api/alerts/stream');
alertSource.onmessage = (e) => {
    try {
        const alerts = JSON.parse(e.data);
        if (!alerts || alerts.length === 0) return;
        const top = alerts[0];
        alertBanner.textContent = `⚠ ${top.type}: ${top.msg}`;
        alertBanner.className = `alert-banner alert-${top.severity.toLowerCase()}`;
        alertBanner.style.display = 'block';
        triggerAlertPulse(top.lat, top.lng);
        clearTimeout(alertHideTimer);
        alertHideTimer = setTimeout(() => { alertBanner.style.display = 'none'; }, 15000);
    } catch(err) {}
};
alertSource.onerror = () => {};

// ── 4D Time Scrubber ──────────────────────────────────────────────────────────
async function timeScrub(hoursAgo) {
    timeScrubHours = hoursAgo;
    const label = document.getElementById('time-label');
    if (hoursAgo === 0) {
        label.textContent = 'LIVE';
        label.style.color = '#00ffcc';
        // Fetch live data directly (guard in fetchEarthquakes checks timeScrubHours, already 0)
        try {
            const res = await fetch('/api/earthquakes');
            if (res.ok) { eqData = await res.json(); updateLayers(); }
        } catch(err) {}
        return;
    }
    const viewEnd = new Date(Date.now() - hoursAgo * 3600 * 1000);
    label.textContent = `-${hoursAgo}h (${viewEnd.toLocaleTimeString()})`;
    label.style.color = '#ffaa00';
    try {
        const res = await fetch(`/api/earthquakes/at?hours_ago=${hoursAgo}`);
        if (!res.ok) return;
        eqData = await res.json();
        updateLayers();
    } catch(err) {}
}

// ── Animation loop ──────────────────────────────────────────────────────────
// Problem: calling world.htmlElementsData() at 20fps recalculates 3D positions
// for 100+ elements every 50ms — very expensive.
//
// Fix: split into two loops:
//   1. rAF fast loop  — only updates CSS transforms/filters on cached elements
//      (aircraft rotation, glow). These are compositor-only — zero Globe.gl cost.
//   2. Throttled loop — calls world.htmlElementsData() at most every 120ms,
//      which repositions elements on the globe. Satellites need this for movement;
//      aircraft only need it when new data arrives (handled in fetchAircraft).

let _globeUpdateScheduled = false;
let _lastGlobeUpdate = 0;

function scheduleGlobeUpdate() {
    if (_globeUpdateScheduled) return;
    _globeUpdateScheduled = true;
    const delay = Math.max(0, 120 - (Date.now() - _lastGlobeUpdate));
    setTimeout(() => {
        _globeUpdateScheduled = false;
        _lastGlobeUpdate = Date.now();
        updateLayers();
    }, delay);
}

// Fast rAF loop: only touches cached element styles — no Globe.gl calls
function fastFrame() {
    if (showAc) {
        for (const d of aircraftData) {
            const el = acElCache[d.icao];
            if (!el) continue;
            const sym = el.querySelector('.ac-sym');
            if (sym) sym.style.transform = `rotate(${d.hdg || 0}deg)`;
        }
    }
    requestAnimationFrame(fastFrame);
}
requestAnimationFrame(fastFrame);

// Satellite positions change continuously — keep globe updated at ~8fps
setInterval(scheduleGlobeUpdate, 120);

setInterval(fetchISS,          5000);
setInterval(fetchAircraft,    10000);
setInterval(fetchEarthquakes, 120000);
setInterval(fetchSatellites, 3600000);  // TLEs once an hour
setInterval(fetchAQI,         600000);  // AQI every 10 min
setInterval(fetchWeather,     600000);  // Weather every 10 min
setInterval(fetchShips,        30000);  // Ships every 30 s
setInterval(fetchNaturalEvents, 300000); // EONET events every 5 min

fetchISS();
fetchAircraft();
fetchEarthquakes();
fetchSatellites();
fetchAQI();
fetchWeather();
fetchShips();
fetchNaturalEvents();

// Day/night terminator — init immediately then update every 60 s
updateDayNight();
setInterval(updateDayNight, 60000);
