import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  ApiError,
  EarlyCompleteRequest,
  EarlyCompleteResponse,
  OptimizationApiRequest,
  OptimizationApiResult,
  ReplanRequest,
  ReplanResponse,
  TransformApiResponse,
} from '../models/api.models';

const API_BASE = 'http://localhost:8000';

@Injectable({ providedIn: 'root' })
export class PortOptimApiService {
  constructor(private http: HttpClient) {}

  /** Upload a CSV/Excel file and return the transformed BerthCall records. */
  transformFile(file: File): Observable<TransformApiResponse> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http
      .post<TransformApiResponse>(`${API_BASE}/api/v1/transform/`, form)
      .pipe(catchError(this.handleError));
  }

  /** Send the optimization request and return the proposed schedule. */
  runOptimization(request: OptimizationApiRequest): Observable<OptimizationApiResult> {
    return this.http
      .post<OptimizationApiResult>(`${API_BASE}/api/v1/optimize/run`, request)
      .pipe(catchError(this.handleError));
  }

  /**
   * Re-plan the schedule after vessel delays.
   * Only triggers full re-scheduling when conflicts are detected;
   * otherwise the fondeo phase absorbs the delay and the berth schedule is
   * returned unchanged.
   */
  replan(request: ReplanRequest): Observable<ReplanResponse> {
    return this.http
      .post<ReplanResponse>(`${API_BASE}/api/v1/optimize/replan`, request)
      .pipe(catchError(this.handleError));
  }

  /**
   * Notify the backend that a vessel finished its cargo operation early.
   * Returns an updated schedule with early-undock and optional pull-forward
   * for vessels waiting in fondeo.
   */
  earlyComplete(request: EarlyCompleteRequest): Observable<EarlyCompleteResponse> {
    return this.http
      .post<EarlyCompleteResponse>(`${API_BASE}/api/v1/optimize/early_complete`, request)
      .pipe(catchError(this.handleError));
  }

  private handleError(err: HttpErrorResponse): Observable<never> {
    const detail =
      (err.error as ApiError)?.detail ??
      err.message ??
      'Unknown server error';
    return throwError(() => new Error(detail));
  }
}
