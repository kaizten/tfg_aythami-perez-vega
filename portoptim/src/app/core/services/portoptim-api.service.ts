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

/* Fixed - base URL of the FastAPI backend */
const API_BASE = 'http://localhost:8000';

@Injectable({ providedIn: 'root' })
export class PortOptimApiService {
  constructor(private http: HttpClient) {}

  /*
   * Uploads a CSV or Excel file to the backend and returns the transformed BerthCall records.
   * @param file - The data file selected by the user (required)
   * @returns Observable that emits the transformed API response
   */
  transformFile(file: File): Observable<TransformApiResponse> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http
      .post<TransformApiResponse>(`${API_BASE}/api/v1/transform/`, form)
      .pipe(catchError(this.handleError));
  }

  /*
   * Sends the optimization request to the backend and returns the proposed berth schedule.
   * @param request - The full optimization API request including vessels and configuration (required)
   * @returns Observable that emits the optimization result
   */
  runOptimization(request: OptimizationApiRequest): Observable<OptimizationApiResult> {
    return this.http
      .post<OptimizationApiResult>(`${API_BASE}/api/v1/optimize/run`, request)
      .pipe(catchError(this.handleError));
  }

  /*
   * Sends a replan request to the backend after vessel delays are detected.
   * Full rescheduling is triggered only when delays cause berth, pilot, or tug conflicts.
   * @param request - The replan request containing the base schedule and accumulated delays (required)
   * @returns Observable that emits the replanned schedule
   */
  replan(request: ReplanRequest): Observable<ReplanResponse> {
    return this.http
      .post<ReplanResponse>(`${API_BASE}/api/v1/optimize/replan`, request)
      .pipe(catchError(this.handleError));
  }

  /*
   * Notifies the backend that a vessel finished its cargo operation early.
   * Returns an updated schedule with early undocking and optional pull-forward for fondeo vessels.
   * @param request - The early-complete request with vessel ID, completion time, and base schedule (required)
   * @returns Observable that emits the updated schedule after early completion
   */
  earlyComplete(request: EarlyCompleteRequest): Observable<EarlyCompleteResponse> {
    return this.http
      .post<EarlyCompleteResponse>(`${API_BASE}/api/v1/optimize/early_complete`, request)
      .pipe(catchError(this.handleError));
  }

  /*
   * Extracts a human-readable error message from an HTTP error response and wraps it in a thrown Observable.
   * @param err - The HttpErrorResponse received from Angular's HttpClient (required)
   * @returns An Observable that immediately errors with a descriptive Error object
   */
  private handleError(err: HttpErrorResponse): Observable<never> {
    const detail =
      (err.error as ApiError)?.detail ??
      err.message ??
      'Unknown server error';
    return throwError(() => new Error(detail));
  }
}
