import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class MapStateService {
  center: [number, number] | null = null;
  zoom: number | null = null;
}
