import './style.css';
import L from 'leaflet';

// ==========================================================================
// CRITICAL: Leaflet Plugin ESM Setup
// Many Leaflet plugins (like leaflet-draw and leaflet-measure) rely on the
// global window.L object to be defined before they run. We bind it here.
// ==========================================================================
window.L = L;

// Import Leaflet Plugins AFTER defining window.L
import 'leaflet-draw';
import 'leaflet-measure';

// ==========================================================================
// FIX: Leaflet Default Marker Icon Paths in Vite Bundler
// By default, Leaflet's CSS uses relative URLs to load marker images.
// In modern bundlers like Vite, these paths can break during packaging.
// We explicitly import and re-map the marker images here.
// ==========================================================================
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

// ==========================================================================
// 1. Initialize Map Container
// Using EPSG:3857 (Web Mercator) as the standard Coordinate Reference System.
// Default center set to Glendalough House (Beyond the Pale venue).
// ==========================================================================
const map = L.map('map', {
  center: [53.04099, -6.26085], // Latitude, Longitude of Glendalough House Estate
  zoom: 16,
  minZoom: 12,
  maxZoom: 24,                  // Deep zoom capability to inspect Mavic 3E details
  zoomControl: true,            // Kept true (styled and pushed down via style.css)
  crs: L.CRS.EPSG3857,
  attributionControl: true,
  tap: false                    // CRITICAL: Fixes drawing/click/drag issues on Windows hybrid & touchscreen devices
});

// ==========================================================================
// Client-Side Elevation Profile & Slope Calculations
// Loads a lightweight resampled grid of the DSM and performs bilinear
// interpolation to compute height values (Z) for coordinates (X, Y) dynamically.
// Configured to load from S3 with a local fallback for offline development.
// ==========================================================================
const s3BucketUrl = 'https://safetyworkflows-drone-maps.s3.eu-north-1.amazonaws.com/beyond-the-pale-2026';
let elevationData = null;

fetch(`${s3BucketUrl}/elevation_grid.json`)
  .then(res => {
    if (!res.ok) throw new Error('S3 response not OK');
    return res.json();
  })
  .catch(err => {
    console.log('[*] S3 fetch failed or blocked by CORS, trying local fallback...', err);
    return fetch('/elevation_grid.json')
      .then(res => {
        if (!res.ok) throw new Error('Local fallback response not OK');
        return res.json();
      });
  })
  .then(data => {
    elevationData = data;
    console.log('[+] Elevation grid DSM loaded successfully');
  })
  .catch(err => {
    console.warn('[!] Elevation profile calculations disabled. Ensure elevation_grid.json is uploaded to the S3 bucket or local public/ folder.', err);
  });

const getElevation = (lat, lon) => {
  if (!elevationData) return null;
  
  const { bounds, grid, rows, cols } = elevationData;
  const { latMin, latMax, lonMin, lonMax } = bounds;
  
  let qLat = lat;
  let qLon = lon;
  
  // Dynamic Coordinate System Detection:
  // If bounds are in Web Mercator meters (EPSG:3857) instead of Lat/Lon (WGS84),
  // we convert the query coordinates to EPSG:3857 to perform the grid lookup.
  if (Math.abs(latMin) > 90 || Math.abs(lonMin) > 180) {
    const R = 6378137;
    qLon = R * (lon * Math.PI / 180);
    qLat = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
  }
  
  // Bounds checking in correct coordinate space
  if (qLat < latMin || qLat > latMax || qLon < lonMin || qLon > lonMax) return null;
  
  // Map coordinates to grid row/col indices (lat index 0 is North/latMax, lon index 0 is West/lonMin)
  const pctLat = (latMax - qLat) / (latMax - latMin);
  const pctLon = (qLon - lonMin) / (lonMax - lonMin);
  
  const r = pctLat * (rows - 1);
  const c = pctLon * (cols - 1);
  
  const r0 = Math.floor(r);
  const r1 = Math.min(r0 + 1, rows - 1);
  const c0 = Math.floor(c);
  const c1 = Math.min(c0 + 1, cols - 1);
  
  const dr = r - r0;
  const dc = c - c0;
  
  const h00 = grid[r0][c0];
  const h01 = grid[r0][c1];
  const h10 = grid[r1][c0];
  const h11 = grid[r1][c1];
  
  // Gracefully handle nodata/null grid cells by falling back to any adjacent valid height
  if (h00 === null || h01 === null || h10 === null || h11 === null) {
    return h00 !== null ? h00 : (h01 !== null ? h01 : (h10 !== null ? h10 : h11));
  }
  
  // Standard bilinear interpolation
  const hTop = h00 * (1 - dc) + h01 * dc;
  const hBottom = h10 * (1 - dc) + h11 * dc;
  return hTop * (1 - dr) + hBottom * dr;
};

// ==========================================================================
// 2. Base Maps and Overlay Layer Setup
// Base maps: Satellite (Esri), OpenStreetMap, and Dark Canvas (default)
// Overlays: Drone Map and Slope Analysis from our S3 bucket.
// ==========================================================================
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
  maxZoom: 19
});

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19
});

// Dark Canvas shows our themed dark grey CSS background behind the overlays
const darkCanvas = L.tileLayer('', {
  maxZoom: 24
});

// Add the Satellite layer as the default base map for a premium GIS visualization
satelliteLayer.addTo(map);

const orthomosaicUrl = `${s3BucketUrl}/ortho-tiles/{z}/{x}/{y}.png`;
const slopeOverlayUrl = `${s3BucketUrl}/slope-tiles/{z}/{x}/{y}.png`;

// Base Orthomosaic Layer
const droneTileLayer = L.tileLayer(orthomosaicUrl, {
  attribution: 'Drone Orthomosaic &copy; <a href="https://safetyworkflows.com" target="_blank">safetyworkflows.com</a> | Glendalough House Survey 2026',
  minZoom: 12,
  maxZoom: 24,                 // Extends zoom level beyond the tile generation limits
  maxNativeZoom: 21,           // The actual max level generated by our tiling scripts (prevents 404s, upscales tiles automatically)
  crossOrigin: true            // CRITICAL: Prevents CORS canvas tainting when using leaflet-measure (allows distance/area logic)
});

// Slope Analysis Overlay Layer (semi-transparent, not added to map by default)
const slopeTileLayer = L.tileLayer(slopeOverlayUrl, {
  attribution: 'Slope Analysis &copy; <a href="https://safetyworkflows.com" target="_blank">safetyworkflows.com</a>',
  minZoom: 12,
  maxZoom: 24,
  maxNativeZoom: 21,
  opacity: 0.75,               // Set default overlay transparency (75% layer opacity combined with 40% transparent colors)
  crossOrigin: true
});

// Add the default drone base map to start
droneTileLayer.addTo(map);

// Handle Tile Loading Errors gracefully
const handleTileError = function(error) {
  console.warn('Map tile failed to load. Ensure your files are uploaded to AWS S3 and public permissions are configured. Error source:', error.tile.src);
};
droneTileLayer.on('tileerror', handleTileError);
slopeTileLayer.on('tileerror', handleTileError);

// Add Layer Toggle Control in the top-right (positioned below the measure tool automatically)
const baseLayers = {
  "Satellite": satelliteLayer,
  "OpenStreetMap": osmLayer,
  "Dark Canvas": darkCanvas
};
const overlayLayers = {
  "Drone Map": droneTileLayer,
  "Slope Analysis": slopeTileLayer
};
L.control.layers(baseLayers, overlayLayers, { collapsed: false, position: 'topright' }).addTo(map);

// ==========================================================================
// 3. Visual Guides and Venue Markers (Spatially Shifted to Align with Drone Orthomosaic)
// Coordinates have been corrected to match the physical drone flight path bounds.
// ==========================================================================
const boundaryGroup = L.featureGroup().addTo(map);

// Glendalough House Main Estate Boundary (Shifted to align with drone tiles)
const estateBoundary = L.polygon([
  [53.044117, -6.265349],
  [53.044617, -6.257349],
  [53.038117, -6.256349],
  [53.037117, -6.264349]
], {
  color: '#00ffd1',
  fillColor: '#00ffd1',
  fillOpacity: 0.05,
  weight: 2,
  dashArray: '5, 10',
  interactive: true
}).addTo(boundaryGroup);

estateBoundary.bindTooltip('Festival Property Bounding Box', { sticky: true });

// Visual markers for key venue locations (Spatially aligned with drone orthomosaic features)
const venues = [
  { name: 'Glendalough House Main Estate', coords: [53.03942, -6.26583], desc: 'Heritage estate house and operations center.' },
  { name: 'Beyond the Pale Main Stage', coords: [53.04230, -6.26361], desc: 'Main Performance Stage. Max capacity 8,500.' },
  { name: 'HQ / Medical Tent', coords: [53.03977, -6.26337], desc: 'Platform Command Center and Emergency Services staging point.' },
  { name: 'Main Campsite Area', coords: [53.040717, -6.261549], desc: 'General camping area. Requires 6m clear emergency fire lanes.' },
  { name: 'Boutique Camping Area', coords: [53.042817, -6.259149], desc: 'Premium glamping zone featuring luxury pre-pitched tents.' }
];

venues.forEach(venue => {
  const marker = L.marker(venue.coords).addTo(boundaryGroup);
  marker.bindPopup(`
    <div style="font-family: 'Outfit', sans-serif; min-width: 180px;">
      <h3 style="margin: 0 0 6px 0; font-size: 14px; color: #1e1e1e;">${venue.name}</h3>
      <p style="margin: 0; font-size: 12px; color: #64748b; line-height: 1.4;">${venue.desc}</p>
    </div>
  `);
});

// ==========================================================================
// 4. Initialize Leaflet Measure Control
// Positioned in top-right corner to calculate stages/crowd capacity.
// ==========================================================================
const measureControl = L.control.measure({
  position: 'topright',
  primaryLengthUnit: 'meters',
  secondaryLengthUnit: 'kilometers',
  primaryAreaUnit: 'sqmeters',
  activeColor: '#00ffd1',
  completedColor: '#00e5ff',
  popupOptions: {
    className: 'leaflet-measure-resultpopup',
    autoPanPadding: [10, 10]
  }
});

measureControl.addTo(map);

// ==========================================================================
// 5. Initialize Leaflet Draw Control (Annotations)
// Pushes created annotations to a dedicated feature group for serialization.
// ==========================================================================
const annotationItems = new L.FeatureGroup();
map.addLayer(annotationItems);

const drawControl = new L.Control.Draw({
  position: 'topleft', // Pushed down using CSS to not block the header overlay
  edit: {
    featureGroup: annotationItems,
    remove: true
  },
  draw: {
    polygon: {
      allowIntersection: false,
      showArea: false,      // CRITICAL: Disable Leaflet.draw inline area display to avoid 'type is not defined' ReferenceError
      metric: true,
      shapeOptions: {
        color: '#00ffd1',
        weight: 3,
        fillColor: '#00ffd1',
        fillOpacity: 0.2
      }
    },
    polyline: {
      metric: true,
      shapeOptions: {
        color: '#00e5ff',
        weight: 4
      }
    },
    rectangle: {
      showArea: false,      // CRITICAL: Bypasses Leaflet.draw 1.0.4 rectangle area calculation crash
      shapeOptions: {
        color: '#a5f3fc',
        weight: 3,
        fillColor: '#a5f3fc',
        fillOpacity: 0.15
      }
    },
    circle: {
      shapeOptions: {
        color: '#f43f5e',
        weight: 3,
        fillColor: '#f43f5e',
        fillOpacity: 0.15
      }
    },
    circlemarker: false, // Disabled to focus on standard shapes
    marker: {
      icon: new L.Icon.Default()
    }
  }
});

map.addControl(drawControl);

// ==========================================================================
// Custom Tooltip Initialization for Controls
// Automatically extracts title attributes from Leaflet control buttons and
// maps them to data-tooltip attributes for high-contrast CSS styled labels.
// ==========================================================================
const initCustomTooltips = () => {
  const buttons = document.querySelectorAll('.leaflet-bar a, .leaflet-draw-toolbar a, .leaflet-control-measure a.js-toggle');
  buttons.forEach(btn => {
    const title = btn.getAttribute('title');
    if (title) {
      // Map descriptive tooltips to make drawing toolbar actions obvious
      let tooltipText = title;
      if (title.toLowerCase().includes('polyline')) tooltipText = 'Draw Route / Polyline';
      if (title.toLowerCase().includes('polygon')) tooltipText = 'Draw Safety Zone / Polygon';
      if (title.toLowerCase().includes('rectangle')) tooltipText = 'Draw Rectangle Zone';
      if (title.toLowerCase().includes('circle')) tooltipText = 'Draw Circular Zone';
      if (title.toLowerCase().includes('marker')) tooltipText = 'Place Emergency Pin';
      if (title.toLowerCase().includes('edit')) tooltipText = 'Edit Drawn Annotations';
      if (title.toLowerCase().includes('delete') || title.toLowerCase().includes('remove')) tooltipText = 'Delete Drawn Annotations';
      
      btn.setAttribute('data-tooltip', tooltipText);
      btn.removeAttribute('title'); // Remove browser default tooltip
    }
  });
};

// Execute tooltip rendering
initCustomTooltips();

// Re-bind tooltips when Draw toolbar switches state (edit/delete modes)
map.on('draw:editstart', () => setTimeout(initCustomTooltips, 50));
map.on('draw:deletestart', () => setTimeout(initCustomTooltips, 50));
map.on('draw:editstop', () => setTimeout(initCustomTooltips, 50));
map.on('draw:deletestop', () => setTimeout(initCustomTooltips, 50));

// ==========================================================================
// Dynamic POI Registration
// Adds user-created annotation markers to the left sidebar navigation links.
// ==========================================================================
const addPoiToNavigation = (name, latlng) => {
  const navList = document.getElementById('nav-poi-list');
  if (!navList) return;
  
  // Prevent duplicate navigation entries
  const existingButtons = navList.querySelectorAll('.nav-btn');
  for (let btn of existingButtons) {
    if (btn.textContent.includes(name)) return;
  }
  
  // Create and style the button dynamically to match premium dashboard styling
  const btn = document.createElement('button');
  btn.className = 'nav-btn custom-poi-btn';
  btn.setAttribute('data-lat', latlng.lat);
  btn.setAttribute('data-lng', latlng.lng);
  btn.setAttribute('data-zoom', '19');
  btn.style.borderColor = 'rgba(0, 255, 209, 0.4)';
  btn.style.background = 'rgba(0, 255, 209, 0.03)';
  btn.innerHTML = `<span class="btn-icon">📍</span> ${name}`;
  
  // Click handler to smooth-fly to the custom POI coordinates
  btn.addEventListener('click', () => {
    map.flyTo(latlng, 19, {
      animate: true,
      duration: 1.8,
      easeLinearity: 0.25
    });
  });
  
  navList.appendChild(btn);
};

// Handle Draw Events (Calculate areas/perimeters and handle POI registrations)
map.on(L.Draw.Event.CREATED, (event) => {
  const layer = event.layer;
  const type = event.layerType;

  // Add metadata popups depending on annotation type
  if (type === 'marker') {
    layer.bindPopup(`
      <div style="font-family: 'Outfit', sans-serif; padding: 6px; min-width: 180px;">
        <h4 style="margin:0 0 6px 0; color:#1e1e1e; font-size:14px;">Custom Safety Pin</h4>
        <input type="text" placeholder="Enter Label (e.g. Exit 4)" class="annotation-label-input" style="width:100%; padding:6px; margin-bottom:8px; border:1px solid #cbd5e1; border-radius:4px; font-family:'Outfit'; font-size:12px;">
        <button class="save-annotation-btn" style="background:#00e5ff; color:#121212; border:none; padding:6px 12px; border-radius:4px; font-family:'Outfit'; cursor:pointer; font-weight:600; font-size:12px; width:100%; transition: background 0.2s;">Save Point of Interest</button>
      </div>
    `);
    
    // Bind click event handler to input form inside popup
    layer.on('popupopen', () => {
      const popupNode = layer.getPopup().getElement();
      if (!popupNode) return;
      const saveBtn = popupNode.querySelector('.save-annotation-btn');
      const input = popupNode.querySelector('.annotation-label-input');
      
      if (saveBtn && input) {
        saveBtn.onclick = () => {
          const label = input.value.trim() || 'Custom Safety Pin';
          layer.setPopupContent(`
            <div style="font-family: 'Outfit', sans-serif; padding: 4px;">
              <h4 style="margin: 0 0 4px 0; color: #1e1e1e; font-size: 14px;">${label}</h4>
              <p style="margin: 0; font-size: 12px; color: #64748b;">Custom Point of Interest</p>
            </div>
          `);
          layer.bindTooltip(label, { permanent: false, direction: 'top' });
          addPoiToNavigation(label, layer.getLatLng());
        };
      }
    });
  } else if (type === 'polygon' || type === 'rectangle') {
    let areaText = 'Calculating...';
    let perimeterText = 'Calculating...';
    try {
      let latlngs = layer.getLatLngs();
      // Handle nested arrays returned for polygons/rectangles
      if (Array.isArray(latlngs[0])) {
        latlngs = latlngs[0];
      }

      // 1. Calculate Geodesic Area
      let area = 0;
      const geomUtil = (window.L && window.L.GeometryUtil) || (L && L.GeometryUtil);
      if (geomUtil && typeof geomUtil.geodesicArea === 'function') {
        area = geomUtil.geodesicArea(latlngs);
      } else {
        // Fallback: Shoelace formula corrected by latitude scale factor cos^2(lat)
        const R = 6378137;
        const projected = latlngs.map(p => {
          const x = R * (p.lng * Math.PI / 180);
          const y = R * Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI / 180) / 2));
          return { x, y };
        });
        let total = 0;
        for (let i = 0; i < projected.length; i++) {
          const p1 = projected[i];
          const p2 = projected[(i + 1) % projected.length];
          total += (p1.x * p2.y) - (p2.x * p1.y);
        }
        const avgLat = latlngs.reduce((sum, p) => sum + p.lat, 0) / latlngs.length;
        const cosLat = Math.cos(avgLat * Math.PI / 180);
        area = Math.abs(total / 2) * cosLat * cosLat;
      }
      
      // Format area (metric)
      if (area >= 1000000) {
        areaText = `${(area / 1000000).toFixed(2)} km²`;
      } else if (area >= 10000) {
        areaText = `${(area / 10000).toFixed(2)} ha`;
      } else {
        areaText = `${area.toFixed(1)} m²`;
      }
      
      // 2. Calculate Perimeter
      let perimeter = 0;
      for (let i = 0; i < latlngs.length; i++) {
        const next = latlngs[(i + 1) % latlngs.length];
        perimeter += latlngs[i].distanceTo(next);
      }
      perimeterText = perimeter < 1000 ? `${perimeter.toFixed(1)} m` : `${(perimeter / 1000).toFixed(2)} km`;
    } catch (e) {
      console.error('Error calculating polygon stats:', e);
      areaText = 'Error';
      perimeterText = 'Error';
    }

    layer.bindPopup(`
      <div style="font-family: 'Outfit', sans-serif; min-width: 180px; padding: 4px;">
        <h4 style="margin:0 0 6px 0; color:#1e1e1e; font-size: 14px;">Custom Safety Zone</h4>
        <div style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#475569;">
          <div><strong style="color:#0f172a;">Type:</strong> ${type.charAt(0).toUpperCase() + type.slice(1)}</div>
          <div><strong style="color:#0f172a;">Calculated Area:</strong> ${areaText}</div>
          <div><strong style="color:#0f172a;">Perimeter Length:</strong> ${perimeterText}</div>
        </div>
      </div>
    `);
  } else if (type === 'circle') {
    let radiusText = 'Calculating...';
    let areaText = 'Calculating...';
    try {
      const radius = layer.getRadius();
      const area = Math.PI * radius * radius;
      
      radiusText = radius < 1000 ? `${radius.toFixed(1)} m` : `${(radius / 1000).toFixed(2)} km`;
      
      // Format area (metric)
      if (area >= 1000000) {
        areaText = `${(area / 1000000).toFixed(2)} km²`;
      } else if (area >= 10000) {
        areaText = `${(area / 10000).toFixed(2)} ha`;
      } else {
        areaText = `${area.toFixed(1)} m²`;
      }
    } catch (e) {
      console.error('Error calculating circle stats:', e);
      radiusText = 'Error';
      areaText = 'Error';
    }

    layer.bindPopup(`
      <div style="font-family: 'Outfit', sans-serif; min-width: 180px; padding: 4px;">
        <h4 style="margin:0 0 6px 0; color:#1e1e1e; font-size: 14px;">Custom Safety Circle</h4>
        <div style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#475569;">
          <div><strong style="color:#0f172a;">Radius:</strong> ${radiusText}</div>
          <div><strong style="color:#0f172a;">Calculated Area:</strong> ${areaText}</div>
        </div>
      </div>
    `);
  } else if (type === 'polyline') {
    let lengthText = 'Calculating...';
    let slopeHtml = '';
    try {
      const latlngs = layer.getLatLngs();
      let length = 0;
      for (let i = 0; i < latlngs.length - 1; i++) {
        length += latlngs[i].distanceTo(latlngs[i+1]);
      }
      lengthText = length < 1000 ? `${length.toFixed(1)} m` : `${(length / 1000).toFixed(2)} km`;

      // If we have DSM elevation data loaded, calculate elevation change and slope gradient
      if (elevationData && latlngs.length >= 2) {
        const start = latlngs[0];
        const end = latlngs[latlngs.length - 1];
        const zStart = getElevation(start.lat, start.lng);
        const zEnd = getElevation(end.lat, end.lng);

        if (zStart !== null && zEnd !== null) {
          const rise = zEnd - zStart;
          const run = length; // Horizontal run in meters
          
          if (run > 0) {
            const grade = (rise / run) * 100;
            const angle = Math.atan(Math.abs(rise) / run) * (180 / Math.PI);
            const direction = rise >= 0 ? 'Rise' : 'Fall';
            
            slopeHtml = `
              <div style="margin-top: 8px; border-top: 1px solid rgba(22, 22, 22, 0.08); padding-top: 8px;">
                <strong style="color:#0f172a; font-size:12px;">Elevation & Slope Profile:</strong>
                <table style="width:100%; font-size:11px; margin-top:4px; color:#475569; border-collapse:collapse;">
                  <tr><td style="padding:2px 0;">Start Elevation:</td><td style="text-align:right; font-weight:600; color:#0f172a;">${zStart.toFixed(1)} m</td></tr>
                  <tr><td style="padding:2px 0;">End Elevation:</td><td style="text-align:right; font-weight:600; color:#0f172a;">${zEnd.toFixed(1)} m</td></tr>
                  <tr><td style="padding:2px 0;">Elevation Change:</td><td style="text-align:right; font-weight:600; color:${rise >= 0 ? '#10b981' : '#ef4444'};">${rise >= 0 ? '+' : ''}${rise.toFixed(1)} m (${direction})</td></tr>
                  <tr><td style="padding:2px 0;">Slope Gradient:</td><td style="text-align:right; font-weight:600; color:#0f172a;">${Math.abs(grade).toFixed(1)}% (${angle.toFixed(1)}°)</td></tr>
                </table>
              </div>
            `;
          }
        }
      }
    } catch (e) {
      console.error('Error calculating path stats:', e);
      lengthText = 'Error';
    }

    layer.bindPopup(`
      <div style="font-family: 'Outfit', sans-serif; min-width: 190px; padding: 4px;">
        <h4 style="margin:0 0 6px 0; color:#1e1e1e; font-size: 14px;">Custom Path / Route</h4>
        <div style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#475569;">
          <div><strong style="color:#0f172a;">Horizontal Length:</strong> ${lengthText}</div>
        </div>
        ${slopeHtml}
      </div>
    `);
  }

  annotationItems.addLayer(layer);
});

// ==========================================================================
// 6. Branded Overlay Navigation Event Handlers
// Triggers smooth flight animation (flyTo) when user selects hot locations.
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  const navButtons = document.querySelectorAll('.nav-btn');
  
  navButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      // Handle nested icon clicks
      const target = e.target.closest('.nav-btn');
      if (!target) return;
      
      const lat = parseFloat(target.getAttribute('data-lat'));
      const lng = parseFloat(target.getAttribute('data-lng'));
      const zoom = parseInt(target.getAttribute('data-zoom'), 10);
      
      if (!isNaN(lat) && !isNaN(lng)) {
        map.flyTo([lat, lng], zoom, {
          animate: true,
          duration: 1.8, // Smooth flight transition duration in seconds
          easeLinearity: 0.25
        });
      }
    });
  });
});
