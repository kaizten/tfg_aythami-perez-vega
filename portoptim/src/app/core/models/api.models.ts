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

// ── Optimizer request / response ───────────────────────────────────────────

export interface VesselOperationInput {
  tipo_operacion: string;
  grupo_mercancia: string;
  cantidad: number | null;
}

export interface VesselInput {
  id: string;
  eta: string;           // ISO 8601
  eslora: number;
  gt: number;
  target_berth: string;
  operations: VesselOperationInput[];
  estimated_duration_h: number | null;
}

export interface OptimizationApiRequest {
  vessels: VesselInput[];
  config: {
    num_pilots: number;
    num_tugs: number;
    default_duration_h: number;
    overlap_factor: number;
    mooring_zones: MooringZoneConfig[];
  };
}

export type DurationSource = 'provided' | 'rate_model' | 'statistical_model' | 'default';
export type AssignmentStatus = 'assigned' | 'unassigned' | 'invalid_berth';
export type PhaseName = 'delay' | 'fondeo' | 'atraque' | 'ejecucion' | 'desatraque' | 'waiting_undock';

export interface OperationPhase {
  name: PhaseName;
  start: string;      // ISO 8601
  end: string;        // ISO 8601
  duration_h: number;
}

export interface OptimizationAssignment {
  vessel_id: string;
  berth_id: string;
  noray_start: number | null;
  noray_end: number | null;
  scheduled_start: string;   // ISO 8601
  scheduled_end: string;     // ISO 8601
  waiting_time_h: number;
  duration_estimated_h: number;
  duration_source: DurationSource;
  pilot_assigned: boolean;
  tugs_required: number;
  tugs_assigned: boolean;
  status: AssignmentStatus;
  caused_delay_to: string[];
  phases: OperationPhase[];
  /** Hours of delay applied to this vessel (set by /replan). Used for the red delay segment in the Gantt. */
  delay_h?: number;
  /** Hours of early arrival (set by /replan for early_arrival type). Used for statistics only — no visual phase. */
  early_arrival_h?: number;
  /** True when docking was delayed by pilot unavailability. */
  pilot_caused_delay?: boolean;
  /** True when docking was delayed by tug unavailability. */
  tug_caused_delay?: boolean;
  /** Fondeo hours attributable specifically to pilot unavailability. */
  pilot_wait_h?: number;
  /** Fondeo hours attributable specifically to tug unavailability. */
  tug_wait_h?: number;
  /** True only when this assignment was modified by the early_complete handler
   *  (user confirmed early cargo completion).  Distinguishes scheduling-induced
   *  waiting_undock phases from user-triggered early completions. */
  early_complete?: boolean;
}

export interface OptimizationKpis {
  total_waiting_time_h: number;
  avg_waiting_time_h: number;
  berth_utilization: Record<string, number>;
  unresolved_vessels: number;
  improvement_vs_greedy_pct: number;
  conflicts_resolved: number;
  duration_source_breakdown: Record<string, number>;
  resource_delays: { pilot_caused: number; tug_caused: number };
}

export interface OptimizationApiResult {
  assignments: OptimizationAssignment[];
  kpis: OptimizationKpis;
  /** vessel_id → applied delay (h). Present only after a /replan call. */
  delay_map?: Record<string, number>;
}

// ── Re-planning ─────────────────────────────────────────────────────────────

export interface VesselDelay {
  vessel_id: string;
  delay_h: number;
  /** "arrival" (vessel not yet docked), "operation" (vessel already at berth), or "early_arrival" (vessel arrived before ETA). */
  delay_type?: 'arrival' | 'operation' | 'early_arrival';
}

export interface ReplanRequest {
  base_assignments: OptimizationAssignment[];
  delays: VesselDelay[];
  config: OptimizationApiRequest['config'];
  vessels: VesselInput[];
}

export interface ReplanResponse {
  assignments: OptimizationAssignment[];
  kpis: OptimizationKpis;
  replan_triggered: boolean;
  vessels_affected: string[];
  conflicts_found: number;
  delay_map: Record<string, number>;
}

// ── Early completion ──────────────────────────────────────────────────────────

export interface EarlyCompleteRequest {
  vessel_id: string;
  /** ISO 8601 timestamp when the cargo operation actually finished. */
  complete_time: string;
  base_assignments: OptimizationAssignment[];
  config: OptimizationApiRequest['config'];
  vessels: VesselInput[];
}

export interface EarlyCompleteResponse {
  assignments: OptimizationAssignment[];
  kpis: OptimizationKpis;
  /** True when waiting vessels for this berth were rescheduled. */
  replan_triggered: boolean;
  /** Hours the vessel waited at berth for undocking resources (0 = immediate). */
  waiting_undock_h: number;
  /** How many hours earlier the berth is freed vs. the original schedule. */
  berth_freed_delta_h: number;
}
