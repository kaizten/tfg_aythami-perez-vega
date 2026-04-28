/** TypeScript interfaces that mirror the FastAPI backend response shapes. */

export interface BerthCall {
  call_id: string;
  berth_id: string;
  noray_start: number | null;
  noray_end: number | null;
  arrival_time: string;    // ISO 8601 string from JSON
  departure_time: string;  // ISO 8601 string from JSON
  vessel_length: number;
  vessel_gt: number;
  operation_type: string;
  cargo_group: string;
  cargo_nature: string;
  quantity: number | null;
  duration_hours: number;
}

export interface TransformationSummary {
  total_input_rows: number;
  valid_rows: number;
  skipped_rows: number;
  skipped_reasons: string[];
}

export interface TransformApiResponse {
  transformation_summary: TransformationSummary;
  data: BerthCall[];
}

export interface ApiError {
  detail: string;
}
