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
  available_ports: string[];
  data: BerthCall[];
}

/** BAP variant that determines how a mooring zone allocates space. */
export type BapType = 'continuous' | 'discrete';

/**
 * User-supplied configuration for one mooring zone.
 * - continuous: berthing position is a continuous variable in [0, noray_max]; no overlaps allowed.
 * - discrete:   fixed number of simultaneous slots (capacity); only temporal occupancy is constrained.
 */
export interface MooringZoneConfig {
  berth_id: string;
  bap_type: BapType;
  noray_max: number | null;  // continuous only — upper bound of the berth axis
  capacity: number | null;   // discrete only  — max simultaneous vessels
}

/** User-supplied inputs for the optimization algorithm. */
export interface OptimizationParams {
  num_pilots: number | null;
  num_tugs: number | null;
  mooring_zones: MooringZoneConfig[];
}

export interface ApiError {
  detail: string;
}
