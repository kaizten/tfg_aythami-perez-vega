export interface BerthCall {
  /* Fixed - unique identifier for this berth call record */
  call_id: string;
  /* Fixed - identifier of the berth where the vessel is assigned */
  berth_id: string;
  /* Computed - mooring line start position along the berth axis (continuous BAP only) */
  noray_start: number | null;
  /* Computed - mooring line end position along the berth axis (continuous BAP only) */
  noray_end: number | null;
  /* Fixed - ISO 8601 vessel arrival timestamp from JSON */
  arrival_time: string;
  /* Fixed - ISO 8601 vessel departure timestamp from JSON */
  departure_time: string;
  /* Fixed - vessel length in metres */
  vessel_length: number;
  /* Fixed - vessel gross tonnage */
  vessel_gt: number;
  /* Fixed - type of port operation performed */
  operation_type: string;
  /* Fixed - cargo group classification */
  cargo_group: string;
  /* Fixed - physical nature of the cargo */
  cargo_nature: string;
  /* Fixed - cargo quantity handled (null when not applicable) */
  quantity: number | null;
  /* Computed - total operation duration in hours */
  duration_hours: number;
}

export interface TransformationSummary {
  /* Computed - total number of rows in the uploaded file */
  total_input_rows: number;
  /* Computed - number of rows successfully parsed and retained */
  valid_rows: number;
  /* Computed - number of rows discarded during transformation */
  skipped_rows: number;
  /* Computed - human-readable reasons for each skipped row */
  skipped_reasons: string[];
}

export interface TransformApiResponse {
  /* Computed - summary statistics of the transformation operation */
  transformation_summary: TransformationSummary;
  /* Computed - list of port identifiers present in the transformed data */
  available_ports: string[];
  /* Computed - transformed berth call records ready for optimization */
  data: BerthCall[];
}

export type BapType = 'continuous' | 'discrete';

export interface MooringZoneConfig {
  /* User-provided - identifier of the mooring zone being configured */
  berth_id: string;
  /* User-provided - BAP variant that determines how space is allocated in this zone */
  bap_type: BapType;
  /* User-provided - upper bound of the berth axis for continuous BAP; null for discrete */
  noray_max: number | null;
  /* User-provided - maximum simultaneous vessels for discrete BAP; null for continuous */
  capacity: number | null;
}

export interface OptimizationParams {
  /* User-provided - number of pilots available for vessel docking operations */
  num_pilots: number | null;
  /* User-provided - number of tugs available to assist vessel manoeuvres */
  num_tugs: number | null;
  /* User-provided - per-berth configuration used by the optimizer */
  mooring_zones: MooringZoneConfig[];
}

export interface ApiError {
  /* Computed - human-readable error message returned by the backend */
  detail: string;
}

export interface VesselOperationInput {
  /* Fixed - type of operation the vessel will perform */
  tipo_operacion: string;
  /* Fixed - cargo group associated with this operation */
  grupo_mercancia: string;
  /* User-provided - quantity of cargo to handle (null when not applicable) */
  cantidad: number | null;
}

export interface VesselInput {
  /* Fixed - unique vessel identifier */
  id: string;
  /* Fixed - estimated time of arrival in ISO 8601 format */
  eta: string;
  /* Fixed - vessel length (eslora) in metres */
  eslora: number;
  /* Fixed - vessel gross tonnage */
  gt: number;
  /* Fixed - identifier of the requested target berth */
  target_berth: string;
  /* Fixed - list of cargo operations to be performed */
  operations: VesselOperationInput[];
  /* User-provided - manually specified operation duration in hours (null to use model estimate) */
  estimated_duration_h: number | null;
}

export interface OptimizationApiRequest {
  /* User-provided - list of vessels to schedule */
  vessels: VesselInput[];
  /* User-provided - resource and berth configuration for the optimizer */
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
  /* Fixed - name identifying this phase in the vessel lifecycle */
  name: PhaseName;
  /* Computed - ISO 8601 timestamp when this phase begins */
  start: string;
  /* Computed - ISO 8601 timestamp when this phase ends */
  end: string;
  /* Computed - duration of this phase in hours */
  duration_h: number;
}

export interface OptimizationAssignment {
  /* Fixed - identifier of the vessel assigned to this slot */
  vessel_id: string;
  /* Computed - identifier of the berth assigned by the optimizer */
  berth_id: string;
  /* Computed - mooring line start position (continuous BAP only) */
  noray_start: number | null;
  /* Computed - mooring line end position (continuous BAP only) */
  noray_end: number | null;
  /* Computed - ISO 8601 timestamp when the berth slot begins */
  scheduled_start: string;
  /* Computed - ISO 8601 timestamp when the berth slot ends */
  scheduled_end: string;
  /* Computed - total time the vessel waited before starting operations, in hours */
  waiting_time_h: number;
  /* Computed - estimated operation duration used by the optimizer, in hours */
  duration_estimated_h: number;
  /* Computed - source that determined the operation duration estimate */
  duration_source: DurationSource;
  /* Computed - true when a pilot was successfully assigned for docking */
  pilot_assigned: boolean;
  /* Computed - number of tugs required for this vessel's manoeuvres */
  tugs_required: number;
  /* Computed - true when all required tugs were successfully assigned */
  tugs_assigned: boolean;
  /* Computed - scheduling outcome for this vessel */
  status: AssignmentStatus;
  /* Computed - list of vessel IDs whose schedule was delayed by this assignment */
  caused_delay_to: string[];
  /* Computed - ordered list of operation phases for this vessel */
  phases: OperationPhase[];
  /* Computed - hours of delay applied to this vessel by a replan call; used for the red delay segment in the Gantt */
  delay_h?: number;
  /* Computed - hours of early arrival before ETA; used for statistics only with no visual phase */
  early_arrival_h?: number;
  /* Computed - true when docking was delayed by pilot unavailability */
  pilot_caused_delay?: boolean;
  /* Computed - true when docking was delayed by tug unavailability */
  tug_caused_delay?: boolean;
  /* Computed - fondeo hours attributable specifically to pilot unavailability */
  pilot_wait_h?: number;
  /* Computed - fondeo hours attributable specifically to tug unavailability */
  tug_wait_h?: number;
  /* Computed - true only when this assignment was modified by the early_complete handler */
  early_complete?: boolean;
}

export interface OptimizationKpis {
  /* Computed - sum of waiting times across all assigned vessels, in hours */
  total_waiting_time_h: number;
  /* Computed - mean waiting time per assigned vessel, in hours */
  avg_waiting_time_h: number;
  /* Computed - fraction of scheduled time each berth was occupied */
  berth_utilization: Record<string, number>;
  /* Computed - number of vessels that could not be assigned to any berth */
  unresolved_vessels: number;
  /* Computed - percentage improvement in total waiting time vs. the greedy baseline */
  improvement_vs_greedy_pct: number;
  /* Computed - number of berth conflicts resolved during local search */
  conflicts_resolved: number;
  /* Computed - count of assignments per duration source type */
  duration_source_breakdown: Record<string, number>;
  /* Computed - number of assignments delayed by pilot or tug unavailability */
  resource_delays: { pilot_caused: number; tug_caused: number };
}

export interface OptimizationApiResult {
  /* Computed - list of vessel-to-berth assignments produced by the optimizer */
  assignments: OptimizationAssignment[];
  /* Computed - aggregate performance indicators for the produced schedule */
  kpis: OptimizationKpis;
  /* Computed - mapping of vessel_id to applied delay hours; present only after a replan call */
  delay_map?: Record<string, number>;
}

export interface VesselDelay {
  /* Fixed - identifier of the vessel receiving the delay */
  vessel_id: string;
  /* User-provided - total accumulated delay to apply, in hours */
  delay_h: number;
  /* User-provided - category of delay: arrival, in-operation, or early arrival */
  delay_type?: 'arrival' | 'operation' | 'early_arrival';
}

export interface ReplanRequest {
  /* Computed - assignment list from the most recent successful operation */
  base_assignments: OptimizationAssignment[];
  /* User-provided - delay events to apply during replanning */
  delays: VesselDelay[];
  /* User-provided - resource and berth configuration used for the replan */
  config: OptimizationApiRequest['config'];
  /* User-provided - full vessel list, needed to rebuild ETAs */
  vessels: VesselInput[];
}

export interface ReplanResponse {
  /* Computed - updated assignment list after replanning */
  assignments: OptimizationAssignment[];
  /* Computed - updated KPIs for the replanned schedule */
  kpis: OptimizationKpis;
  /* Computed - true when at least one berth schedule was modified */
  replan_triggered: boolean;
  /* Computed - list of vessel IDs whose schedule changed during replanning */
  vessels_affected: string[];
  /* Computed - number of berth conflicts detected and resolved */
  conflicts_found: number;
  /* Computed - mapping of vessel_id to the applied delay hours */
  delay_map: Record<string, number>;
}

export interface EarlyCompleteRequest {
  /* Fixed - identifier of the vessel that finished early */
  vessel_id: string;
  /* User-provided - ISO 8601 timestamp when the cargo operation actually finished */
  complete_time: string;
  /* Computed - assignment list from the most recent successful operation */
  base_assignments: OptimizationAssignment[];
  /* User-provided - resource and berth configuration used for the replan */
  config: OptimizationApiRequest['config'];
  /* User-provided - full vessel list used to resolve dependencies */
  vessels: VesselInput[];
}

export interface EarlyCompleteResponse {
  /* Computed - updated assignment list after processing early completion */
  assignments: OptimizationAssignment[];
  /* Computed - updated KPIs for the schedule after early completion */
  kpis: OptimizationKpis;
  /* Computed - true when waiting vessels for this berth were rescheduled */
  replan_triggered: boolean;
  /* Computed - hours the vessel waited at berth for undocking resources (0 = immediate) */
  waiting_undock_h: number;
  /* Computed - how many hours earlier the berth is freed vs. the original schedule */
  berth_freed_delta_h: number;
}
