import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class MapStateService {
  /* User-provided - last known map center coordinates preserved across navigation */
  center: [number, number] | null = null;
  /* User-provided - last known map zoom level preserved across navigation */
  zoom: number | null = null;
}
