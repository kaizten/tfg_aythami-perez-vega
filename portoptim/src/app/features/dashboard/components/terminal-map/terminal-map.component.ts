import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import * as L from 'leaflet';
import { Subject, Subscription, debounceTime, distinctUntilChanged, interval } from 'rxjs';
import { AisStreamService, AisVesselPosition } from '../../services/ais-stream.service';
import { MapStateService } from '../../../../core/map-state.service';

/* Fixed - mapping from AIS navigational status code to human-readable label */
const NAV_LABELS: Record<number, string> = {
  0:  'Under way (engine)',
  1:  'At anchor',
  2:  'Not under command',
  3:  'Restricted manoeuvrability',
  4:  'Constrained by draught',
  5:  'Moored',
  6:  'Aground',
  7:  'Engaged in fishing',
  8:  'Under way (sailing)',
  15: 'Not defined',
};

/*
 * Returns a hex color string representing a vessel marker based on its navigational status.
 * @param status - AIS navigational status code, or null if unknown (required)
 * @returns Hex color string for the vessel icon fill
 */
function vesselColor(status: number | null): string {
  switch (status) {
    case 0: case 8: return '#22c55e';
    case 1:         return '#eab308';
    case 5:         return '#3b82f6';
    default:        return '#94a3b8';
  }
}

/*
 * Builds a Leaflet DivIcon containing an SVG vessel shape rotated to the given heading.
 * @param heading - True heading in degrees, or null to use 0 degrees (required)
 * @param navStatus - AIS navigational status used to determine icon color (required)
 * @returns Configured Leaflet DivIcon ready to attach to a marker
 */
function buildIcon(heading: number | null, navStatus: number | null): L.DivIcon {
  const color = vesselColor(navStatus);
  const deg   = heading ?? 0;
  const svg   = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"
      style="transform:rotate(${deg}deg);display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">
    <polygon points="10,2 16,17 10,13 4,17"
             fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
  return L.divIcon({ className: '', html: svg, iconSize: [20, 20], iconAnchor: [10, 10] });
}

interface VesselTrack { marker: L.Marker; lastSeen: number; latlng: L.LatLng; }
/* Fixed - milliseconds after which a vessel without a position update is considered stale */
const STALE_MS = 10 * 60 * 1_000;

type MapMode = 'satellite' | 'street';

export interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
}

@Component({
  selector: 'app-terminal-map',
  standalone: false,
  templateUrl: './terminal-map.component.html',
  styleUrl: './terminal-map.component.scss',
})
export class TerminalMapComponent implements AfterViewInit, OnDestroy {
  /* User-provided - reference to the native map container element obtained via ViewChild */
  @ViewChild('mapEl') private mapEl!: ElementRef<HTMLDivElement>;

  /* Computed - currently active tile layer mode, either satellite or street */
  mapMode: MapMode = 'street';

  /* Computed - Leaflet map instance created after the view is initialized */
  private map!: L.Map;
  /* Computed - Esri World Imagery tile layer for satellite mode */
  private satelliteLayer!: L.TileLayer;
  /* Computed - CartoDB labels overlay displayed on top of the satellite layer */
  private labelsLayer!: L.TileLayer;
  /* Computed - OpenStreetMap tile layer for street mode */
  private streetLayer!: L.TileLayer;
  /* Computed - live map of MMSI to vessel track data for all currently displayed vessels */
  private vessels = new Map<number, VesselTrack>();
  /* Computed - composite subscription collecting all active RxJS subscriptions */
  private subs    = new Subscription();
  /* Computed - ResizeObserver that invalidates map size when the container is resized */
  private resizeObserver!: ResizeObserver;
  /* Computed - Subject that debounces search input keystrokes before firing autocomplete requests */
  private readonly searchSubject = new Subject<string>();
  /* Computed - Subject that debounces map move events before sending the bounding box to the backend */
  private readonly bboxSubject   = new Subject<void>();

  /* Computed - current list of location autocomplete suggestions from Nominatim */
  suggestions: NominatimResult[] = [];
  /* Computed - whether the suggestions dropdown is currently visible */
  showSuggestions = false;
  /* Computed - whether a Nominatim request is currently in-flight */
  searching       = false;
  /* Computed - whether the last search returned no results */
  searchNotFound  = false;

  constructor(readonly ais: AisStreamService, private readonly mapState: MapStateService) {}

  /*
   * Initializes the Leaflet map, tile layers, ResizeObserver, and AIS subscription after the view is ready.
   */
  ngAfterViewInit(): void {
    const el = this.mapEl.nativeElement;

    this.map = L.map(el, {
      center: this.mapState.center ?? [28.134, -15.425],
      zoom:   this.mapState.zoom   ?? 14,
      minZoom: 1.5,
      zoomControl: true,
      preferCanvas: true,
    });

    this.satelliteLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Imagery &copy; <a href="https://www.esri.com" target="_blank">Esri</a>',
        maxZoom: 19,
        keepBuffer: 4,
        updateWhenIdle: false,
        updateWhenZooming: false,
      },
    );

    const labelsPane = this.map.createPane('labels');
    labelsPane.style.zIndex        = '450';
    labelsPane.style.pointerEvents = 'none';
    this.labelsLayer = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
      { pane: 'labels', subdomains: 'abcd', maxZoom: 19, opacity: 0.85,
        updateWhenIdle: false, updateWhenZooming: false },
    );

    this.streetLayer = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
        maxZoom: 19,
        keepBuffer: 4,
        updateWhenIdle: false,
        updateWhenZooming: false,
      },
    );
    this.streetLayer.addTo(this.map);

    this.resizeObserver = new ResizeObserver(() => this.map.invalidateSize());
    this.resizeObserver.observe(el);

    this.map.on('moveend', () => this.onMapMoved());

    this.subs.add(
      this.bboxSubject.pipe(debounceTime(1000))
        .subscribe(() => {
          const b  = this.map.getBounds();
          const sw = b.getSouthWest();
          const ne = b.getNorthEast();
          this.ais.sendBbox(sw.lat, sw.lng, ne.lat, ne.lng);
        })
    );

    this.subs.add(
      this.searchSubject.pipe(debounceTime(350), distinctUntilChanged())
        .subscribe(q => this.fetchSuggestions(q))
    );

    this.ais.connect();
    for (const pos of this.ais.lastKnownPositions.values()) this.onPosition(pos);
    this.subs.add(this.ais.positions$.subscribe(p => this.onPosition(p)));
    this.subs.add(interval(60_000).subscribe(() => this.purgeStale()));
  }

  /*
   * Switches between satellite and street tile layers without reloading the page.
   * @param mode - The desired map mode: 'satellite' or 'street' (required)
   */
  setMapMode(mode: MapMode): void {
    if (mode === this.mapMode) return;
    this.mapMode = mode;
    if (mode === 'satellite') {
      this.streetLayer.remove();
      this.satelliteLayer.addTo(this.map);
      this.labelsLayer.addTo(this.map);
    } else {
      this.labelsLayer.remove();
      this.satelliteLayer.remove();
      this.streetLayer.addTo(this.map);
    }
  }

  /*
   * Persists the current map viewport to MapStateService, disconnects the ResizeObserver, and removes the map.
   */
  ngOnDestroy(): void {
    const c = this.map?.getCenter();
    if (c) this.mapState.center = [c.lat, c.lng];
    this.mapState.zoom = this.map?.getZoom() ?? null;
    this.resizeObserver?.disconnect();
    this.subs.unsubscribe();
    this.map?.remove();
  }

  /*
   * Handles search input changes, clearing suggestions for short queries and debouncing autocomplete requests.
   * @param value - Current value of the search input field (required)
   */
  onSearchInput(value: string): void {
    this.searchNotFound = false;
    const q = value.trim();
    if (q.length < 2) {
      this.suggestions    = [];
      this.showSuggestions = false;
      return;
    }
    this.searchSubject.next(q);
  }

  /*
   * Handles the Enter key in the search box by selecting the first suggestion or falling back to a direct search.
   * @param input - The search input element used to read and update the displayed value (required)
   */
  onEnter(input: HTMLInputElement): void {
    if (this.suggestions.length > 0) {
      this.selectSuggestion(this.suggestions[0], input);
    } else {
      void this.searchFallback(input.value, input);
    }
  }

  /*
   * Flies the map to the selected Nominatim result and closes the suggestion dropdown.
   * @param result - The chosen Nominatim search result (required)
   * @param input - The search input element whose display value will be updated (required)
   */
  selectSuggestion(result: NominatimResult, input: HTMLInputElement): void {
    this.map.flyTo([parseFloat(result.lat), parseFloat(result.lon)], 14, { duration: 1.2 });
    input.value          = this.suggestionName(result);
    this.showSuggestions = false;
    this.suggestions     = [];
  }

  /*
   * Clears the search input and hides suggestions and error states.
   * @param input - The search input element to clear (required)
   */
  clearSearch(input: HTMLInputElement): void {
    input.value          = '';
    this.suggestions     = [];
    this.showSuggestions = false;
    this.searchNotFound  = false;
  }

  /*
   * Hides the suggestions dropdown with a short delay so click events on suggestions fire first.
   */
  closeSuggestions(): void {
    setTimeout(() => { this.showSuggestions = false; }, 150);
  }

  /*
   * Extracts the primary display name from a Nominatim result, preferring the name field over display_name.
   * @param r - A Nominatim geocoding result object (required)
   * @returns The primary place name string
   */
  suggestionName(r: NominatimResult): string {
    return r.name?.trim() || r.display_name.split(',')[0].trim();
  }

  /*
   * Extracts a short secondary description from a Nominatim result for display below the primary name.
   * @param r - A Nominatim geocoding result object (required)
   * @returns A comma-joined substring of the full display name
   */
  suggestionSub(r: NominatimResult): string {
    return r.display_name.split(',').slice(1, 4).join(', ').trim();
  }

  /*
   * Fetches up to five autocomplete suggestions from the Nominatim API for the given query string.
   * @param query - The trimmed search string to geocode (required)
   */
  private async fetchSuggestions(query: string): Promise<void> {
    this.searching = true;
    try {
      const url  = `https://nominatim.openstreetmap.org/search`
                 + `?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=0`;
      const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json() as NominatimResult[];
      this.suggestions     = data;
      this.showSuggestions = data.length > 0;
    } catch {
      this.suggestions     = [];
      this.showSuggestions = false;
    } finally {
      this.searching = false;
    }
  }

  /*
   * Performs a direct single-result Nominatim search and flies the map to the result, or sets searchNotFound on failure.
   * @param query - The full search string entered by the user (required)
   * @param input - The search input element used to update the displayed value on success (required)
   */
  private async searchFallback(query: string, input: HTMLInputElement): Promise<void> {
    const q = query.trim();
    if (!q || this.searching) return;

    this.searching      = true;
    this.searchNotFound = false;
    this.showSuggestions = false;

    try {
      const url  = `https://nominatim.openstreetmap.org/search`
                 + `?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=0`;
      const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json() as NominatimResult[];

      if (data.length > 0) {
        this.map.flyTo([parseFloat(data[0].lat), parseFloat(data[0].lon)], 14, { duration: 1.2 });
        input.value = this.suggestionName(data[0]);
      } else {
        this.searchNotFound = true;
        setTimeout(() => (this.searchNotFound = false), 3000);
      }
    } catch {
      this.searchNotFound = true;
      setTimeout(() => (this.searchNotFound = false), 3000);
    } finally {
      this.searching = false;
    }
  }

  /*
   * Creates or updates a Leaflet marker for the given AIS position report.
   * @param pos - Vessel position data received from the AIS stream (required)
   */
  private onPosition(pos: AisVesselPosition): void {
    const latlng   = L.latLng(pos.latitude, pos.longitude);
    const icon     = buildIcon(pos.heading, pos.navStatus);
    const existing = this.vessels.get(pos.mmsi);

    if (existing) {
      existing.marker.setLatLng(latlng).setIcon(icon);
      existing.marker.getPopup()?.setContent(this.popupHtml(pos));
      existing.lastSeen = Date.now();
      existing.latlng   = latlng;
    } else {
      const marker = L.marker(latlng, { icon })
        .bindPopup(this.popupHtml(pos))
        .addTo(this.map);
      this.vessels.set(pos.mmsi, { marker, lastSeen: Date.now(), latlng });
    }
  }

  /*
   * Generates the HTML string for a vessel marker popup containing name, MMSI, SOG, heading, and status.
   * @param pos - Vessel position data to render in the popup (required)
   * @returns HTML string ready to pass to Leaflet's popup setContent
   */
  private popupHtml(pos: AisVesselPosition): string {
    const status = NAV_LABELS[pos.navStatus ?? 15] ?? 'Unknown';
    return `
      <div style="font-family:system-ui,sans-serif;font-size:12px;min-width:175px;line-height:1.7">
        <strong style="font-size:13px;display:block;margin-bottom:4px;color:#0f172a">${pos.shipName}</strong>
        <span style="color:#64748b">MMSI</span> ${pos.mmsi}<br>
        <span style="color:#64748b">SOG</span> ${pos.sog !== null ? pos.sog.toFixed(1) + ' kn' : '—'}<br>
        <span style="color:#64748b">HDG</span> ${pos.heading !== null ? pos.heading + '°' : '—'}<br>
        <span style="color:#64748b">Status</span> ${status}
      </div>`;
  }

  /*
   * Removes out-of-bounds vessel markers and queues a bounding-box update to the backend after map movement.
   */
  private onMapMoved(): void {
    this.removeOutOfBoundsVessels(this.map.getBounds());
    this.bboxSubject.next();
  }

  /*
   * Removes from the map and internal cache all vessels whose last known position is outside the given bounds.
   * @param bounds - Current Leaflet map bounds used as the visibility filter (required)
   */
  private removeOutOfBoundsVessels(bounds: L.LatLngBounds): void {
    for (const [mmsi, track] of this.vessels) {
      if (!bounds.contains(track.latlng)) {
        track.marker.remove();
        this.vessels.delete(mmsi);
      }
    }
  }

  /*
   * Removes all vessel markers from the map and clears the internal vessel cache.
   */
  private clearVessels(): void {
    for (const track of this.vessels.values()) track.marker.remove();
    this.vessels.clear();
  }

  /*
   * Removes vessel markers that have not received a position update within the stale timeout.
   */
  private purgeStale(): void {
    const cutoff = Date.now() - STALE_MS;
    for (const [mmsi, track] of this.vessels) {
      if (track.lastSeen < cutoff) {
        track.marker.remove();
        this.vessels.delete(mmsi);
      }
    }
  }
}
