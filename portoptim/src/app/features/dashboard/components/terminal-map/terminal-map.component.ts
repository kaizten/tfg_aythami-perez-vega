import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import * as L from 'leaflet';
import { Subscription, interval } from 'rxjs';
import { AisStreamService, AisVesselPosition } from '../../services/ais-stream.service';

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
    case 0: case 8: return '#22c55e'; // green:  under way
    case 1:         return '#eab308'; // yellow: at anchor
    case 5:         return '#3b82f6'; // blue:   moored
    default:        return '#94a3b8'; // gray:   other / unknown
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

interface VesselTrack { marker: L.Marker; lastSeen: number; }

const STALE_MS = 10 * 60 * 1_000; // 10 minutes

@Component({
  selector: 'app-terminal-map',
  standalone: false,
  templateUrl: './terminal-map.component.html',
  styleUrl: './terminal-map.component.scss',
})
export class TerminalMapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapEl') private mapEl!: ElementRef<HTMLDivElement>;

  private map!: L.Map;
  private vessels = new Map<number, VesselTrack>();
  private subs = new Subscription();
  private resizeObserver!: ResizeObserver;

  constructor(readonly ais: AisStreamService) {}

  ngAfterViewInit(): void {
    const el = this.mapEl.nativeElement;

    this.map = L.map(el, {
      center: [28.134, -15.425],  // Puerto de La Luz, Las Palmas de Gran Canaria
      zoom: 14,
      zoomControl: true,
      preferCanvas: true,         // renders markers on <canvas> — faster for many vessels
    });

    // Satellite base — Esri World Imagery (free, fast CDN, no API key)
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Imagery &copy; <a href="https://www.esri.com" target="_blank">Esri</a>',
        maxZoom: 19,
        keepBuffer: 4,
        updateWhenIdle: false,
        updateWhenZooming: false,
      }
    ).addTo(this.map);

    // Labels overlay — street / place names on top of satellite
    const labelsPane = this.map.createPane('labels');
    labelsPane.style.zIndex = '450';
    labelsPane.style.pointerEvents = 'none';
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
      {
        pane: 'labels',
        subdomains: 'abcd',
        maxZoom: 19,
        opacity: 0.85,
        updateWhenIdle: false,
        updateWhenZooming: false,
      }
    ).addTo(this.map);

    // ResizeObserver: tells Leaflet the real container size whenever it changes.
    // Much more reliable than a setTimeout — fires after the browser has actually painted.
    this.resizeObserver = new ResizeObserver(() => this.map.invalidateSize());
    this.resizeObserver.observe(el);

    this.ais.connect();
    this.subs.add(this.ais.positions$.subscribe(p => this.onPosition(p)));
    this.subs.add(interval(60_000).subscribe(() => this.purgeStale()));
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.subs.unsubscribe();
    this.ais.disconnect();
    this.map?.remove();
  }

  private onPosition(pos: AisVesselPosition): void {
    const latlng: L.LatLngExpression = [pos.latitude, pos.longitude];
    const icon    = buildIcon(pos.heading, pos.navStatus);
    const existing = this.vessels.get(pos.mmsi);

    if (existing) {
      existing.marker.setLatLng(latlng).setIcon(icon);
      existing.marker.getPopup()?.setContent(this.popupHtml(pos));
      existing.lastSeen = Date.now();
    } else {
      const marker = L.marker(latlng, { icon })
        .bindPopup(this.popupHtml(pos))
        .addTo(this.map);
      this.vessels.set(pos.mmsi, { marker, lastSeen: Date.now() });
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
