import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  ApiError,
  OptimizationApiRequest,
  OptimizationApiResult,
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

  private handleError(err: HttpErrorResponse): Observable<never> {
    const detail =
      (err.error as ApiError)?.detail ??
      err.message ??
      'Unknown server error';
    return throwError(() => new Error(detail));
  }
}
