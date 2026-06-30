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

/* Fixed - WebSocket endpoint URL of the FastAPI backend AIS relay */
const WS_URL = 'ws://localhost:8000/ws/ais-stream';

@Injectable({ providedIn: 'root' })
export class AisStreamService implements OnDestroy {
  /* Computed - active WebSocket connection instance, null when disconnected */
  private socket: WebSocket | null = null;
  /* Computed - handle for the pending reconnection timer, null when no reconnect is scheduled */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /* Computed - current delay in milliseconds before the next reconnection attempt */
  private reconnectDelay = 1_000;
  /* Computed - flag indicating whether the connection has been intentionally stopped */
  private stopped = false;

  /* Computed - cache of the most recent position report keyed by vessel MMSI */
  readonly lastKnownPositions = new Map<number, AisVesselPosition>();

  /* Computed - internal Subject that emits each incoming vessel position update */
  private readonly _positions$ = new Subject<AisVesselPosition>();
  /* Computed - public Observable of incoming vessel position updates */
  readonly positions$ = this._positions$.asObservable();

  /* Computed - internal BehaviorSubject holding the current WebSocket connection status */
  private readonly _status$ = new BehaviorSubject<'live' | 'reconnecting'>('reconnecting');
  /* Computed - public Observable of the current WebSocket connection status */
  readonly status$ = this._status$.asObservable();

  /*
   * Opens the WebSocket connection if not already open or connecting.
   */
  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
    this.stopped = false;
    this._open();
  }

  /*
   * Sends a bounding-box filter to the backend so only vessels within the viewport are streamed.
   * @param swLat - Latitude of the south-west corner (required)
   * @param swLng - Longitude of the south-west corner (required)
   * @param neLat - Latitude of the north-east corner (required)
   * @param neLng - Longitude of the north-east corner (required)
   */
  sendBbox(swLat: number, swLng: number, neLat: number, neLng: number): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'bbox',
        bbox: [[[swLat, swLng], [neLat, neLng]]],
      }));
    }
  }

  /*
   * Permanently closes the WebSocket connection and cancels any pending reconnect timer.
   */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  /*
   * Disconnects the WebSocket when the service is destroyed by Angular's DI.
   */
  ngOnDestroy(): void {
    this.disconnect();
  }

  /*
   * Creates a new WebSocket connection and attaches open, message, close, and error handlers.
   */
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

  /*
   * Schedules a reconnection attempt using exponential back-off up to a maximum of 30 seconds.
   */
  private _scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this._open();
    }, this.reconnectDelay);
  }
}
