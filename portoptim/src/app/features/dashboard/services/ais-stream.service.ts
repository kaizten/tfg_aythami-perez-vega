import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export interface AisVesselPosition {
  mmsi: number;
  shipName: string;
  latitude: number;
  longitude: number;
  sog: number | null;
  heading: number | null;
  navStatus: number | null;
  timeUtc: string;
}

/** WebSocket URL of the FastAPI backend relay — adjust port if needed. */
const WS_URL = 'ws://localhost:8000/ws/ais-stream';

@Injectable({ providedIn: 'root' })
export class AisStreamService implements OnDestroy {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private stopped = false;

  readonly lastKnownPositions = new Map<number, AisVesselPosition>();

  private readonly _positions$ = new Subject<AisVesselPosition>();
  readonly positions$ = this._positions$.asObservable();

  private readonly _status$ = new BehaviorSubject<'live' | 'reconnecting'>('reconnecting');
  readonly status$ = this._status$.asObservable();

  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
    this.stopped = false;
    this._open();
  }

  sendBbox(swLat: number, swLng: number, neLat: number, neLng: number): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'bbox',
        bbox: [[[swLat, swLng], [neLat, neLng]]],
      }));
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  private _open(): void {
    if (this.stopped) return;

    this.socket = new WebSocket(WS_URL);

    this.socket.onopen = () => {
      this._status$.next('live');
      this.reconnectDelay = 1_000;
    };

    this.socket.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.MessageType !== 'PositionReport') return;
        const meta = msg.MetaData ?? {};
        const pr   = msg.Message?.PositionReport ?? {};
        const heading = pr.TrueHeading;
        const pos: AisVesselPosition = {
          mmsi:      meta.MMSI,
          shipName:  String(meta.ShipName ?? 'Unknown').trim(),
          latitude:  meta.latitude,
          longitude: meta.longitude,
          sog:       pr.Sog ?? null,
          heading:   (heading != null && heading !== 511) ? heading : null,
          navStatus: pr.NavigationalStatus ?? null,
          timeUtc:   meta.time_utc ?? '',
        };
        this.lastKnownPositions.set(pos.mmsi, pos);
        this._positions$.next(pos);
      } catch { /* ignore malformed */ }
    };

    this.socket.onclose = () => {
      this._status$.next('reconnecting');
      if (!this.stopped) this._scheduleReconnect();
    };

    this.socket.onerror = () => { this.socket?.close(); };
  }

  private _scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this._open();
    }, this.reconnectDelay);
  }
}
