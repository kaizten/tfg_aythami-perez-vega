import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import * as L from 'leaflet';
import { Subject, Subscription, debounceTime, distinctUntilChanged, interval } from 'rxjs';
import { AisStreamService, AisVesselPosition } from '../../services/ais-stream.service';
import { MapStateService } from '../../../../core/map-state.service';

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

function vesselColor(status: number | null): string {
  switch (status) {
    case 0: case 8: return '#22c55e';
    case 1:         return '#eab308';
    case 5:         return '#3b82f6';
    default:        return '#94a3b8';
  }
}

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
  @ViewChild('mapEl') private mapEl!: ElementRef<HTMLDivElement>;

  mapMode: MapMode = 'street';

  private map!: L.Map;
  private satelliteLayer!: L.TileLayer;
  private labelsLayer!: L.TileLayer;
  private streetLayer!: L.TileLayer;
  private vessels = new Map<number, VesselTrack>();
  private subs    = new Subscription();
  private resizeObserver!: ResizeObserver;
  private readonly searchSubject = new Subject<string>();
  private readonly bboxSubject   = new Subject<void>();

  // Search state
  suggestions: NominatimResult[] = [];
  showSuggestions = false;
  searching       = false;
  searchNotFound  = false;

  constructor(readonly ais: AisStreamService, private readonly mapState: MapStateService) {}

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

    // Send bbox to backend only after user stops moving for 1 s
    this.subs.add(
      this.bboxSubject.pipe(debounceTime(1000))
        .subscribe(() => {
          const b  = this.map.getBounds();
          const sw = b.getSouthWest();
          const ne = b.getNorthEast();
          this.ais.sendBbox(sw.lat, sw.lng, ne.lat, ne.lng);
        })
    );

    // Debounced autocomplete — 350 ms after the user stops typing
    this.subs.add(
      this.searchSubject.pipe(debounceTime(350), distinctUntilChanged())
        .subscribe(q => this.fetchSuggestions(q))
    );

    this.ais.connect();
    for (const pos of this.ais.lastKnownPositions.values()) this.onPosition(pos);
    this.subs.add(this.ais.positions$.subscribe(p => this.onPosition(p)));
    this.subs.add(interval(60_000).subscribe(() => this.purgeStale()));
  }

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

  ngOnDestroy(): void {
    const c = this.map?.getCenter();
    if (c) this.mapState.center = [c.lat, c.lng];
    this.mapState.zoom = this.map?.getZoom() ?? null;
    this.resizeObserver?.disconnect();
    this.subs.unsubscribe();
    this.map?.remove();
  }

  // ── Search ────────────────────────────────────────────────────────────────

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

  onEnter(input: HTMLInputElement): void {
    if (this.suggestions.length > 0) {
      this.selectSuggestion(this.suggestions[0], input);
    } else {
      void this.searchFallback(input.value, input);
    }
  }

  selectSuggestion(result: NominatimResult, input: HTMLInputElement): void {
    this.map.flyTo([parseFloat(result.lat), parseFloat(result.lon)], 14, { duration: 1.2 });
    input.value          = this.suggestionName(result);
    this.showSuggestions = false;
    this.suggestions     = [];
  }

  clearSearch(input: HTMLInputElement): void {
    input.value          = '';
    this.suggestions     = [];
    this.showSuggestions = false;
    this.searchNotFound  = false;
  }

  closeSuggestions(): void {
    // Slight delay so a click on a suggestion fires before the dropdown disappears
    setTimeout(() => { this.showSuggestions = false; }, 150);
  }

  suggestionName(r: NominatimResult): string {
    return r.name?.trim() || r.display_name.split(',')[0].trim();
  }

  suggestionSub(r: NominatimResult): string {
    return r.display_name.split(',').slice(1, 4).join(', ').trim();
  }

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

  // ── AIS ───────────────────────────────────────────────────────────────────

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

  private onMapMoved(): void {
    this.removeOutOfBoundsVessels(this.map.getBounds());
    this.bboxSubject.next();
  }

  private removeOutOfBoundsVessels(bounds: L.LatLngBounds): void {
    for (const [mmsi, track] of this.vessels) {
      if (!bounds.contains(track.latlng)) {
        track.marker.remove();
        this.vessels.delete(mmsi);
      }
    }
  }

  private clearVessels(): void {
    for (const track of this.vessels.values()) track.marker.remove();
    this.vessels.clear();
  }

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
