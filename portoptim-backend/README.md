# portoptim-backend

Python REST API for the **PortOptim** maritime berth scheduling system, developed as part of a Final Degree Project (TFG) in Computer Engineering at the Universidad de Las Palmas de Gran Canaria.

---

## Modules

| Module | Status | Description |
|---|---|---|
| `data_transformer` | ✅ Implemented | Transforms heterogeneous Spanish port CSV data into standardised `BerthCall` records |
| `optimizer` | ✅ Implemented | Three-phase berth scheduling algorithm: calibration → greedy → local search |
| `ais_relay` | ✅ Implemented | WebSocket relay that bridges the aisstream.io live feed to Angular dashboard clients |

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | [FastAPI](https://fastapi.tiangolo.com/) |
| Validation | [Pydantic v2](https://docs.pydantic.dev/latest/) |
| Data processing | [pandas](https://pandas.pydata.org/) |
| Config management | [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) |
| Server | [uvicorn](https://www.uvicorn.org/) |
| WebSocket client | [websockets](https://websockets.readthedocs.io/) |
| Logging | [structlog](https://www.structlog.org/) |
| Testing | [pytest](https://pytest.org/) + [httpx](https://www.python-httpx.org/) |

---

## Quick start

```bash
# 1. Create and activate virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set up environment variables
cp .env.example .env

# 4. Start the development server
uvicorn main:app --reload
```

Interactive API docs available at **`http://localhost:8000/docs`**.

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/api/v1/transform/` | Upload CSV/Excel → returns transformed `BerthCall` array |
| `POST` | `/api/v1/optimize/run` | Run the scheduling optimizer → returns assignments + KPIs |
| `POST` | `/api/v1/optimize/replan` | Re-plan after vessel delays → returns updated schedule |
| `POST` | `/api/v1/optimize/early_complete` | Handle early cargo-operation completion → cascades pull-forward |
| `GET` | `/api/v1/optimize/calibration-stats` | Inspect loaded calibration model statistics |
| `POST` | `/api/v1/optimize/calibrate` | Load a historical CSV and fit the duration model |
| `WebSocket` | `/ws/ais-stream` | Live AIS vessel position relay (fan-out to all connected dashboard clients) |

---

## Data transformer

Processes CSV files exported from Spanish port management systems with heterogeneous formats, inconsistent date patterns, and missing values.

### Pipeline

```
CSV upload
    │
    ▼
validate_schema          → checks required columns exist, raises informative error if missing
    │
    ▼
rename_columns           → maps Spanish input column names to standardised English field names
    │
    ▼
clean                    → removes fully empty rows, deduplicates by (call_id + operation_type),
                           strips whitespace from string fields
    │
    ▼
normalize                → parses dates (multiple format fallbacks), coerces numeric types,
                           maps operation_type to controlled vocabulary
    │
    ▼
merge_concurrent_ops     → collapses rows where the same vessel performs multiple operations
                           at the same berth during the exact same time window into one record;
                           operation_type becomes e.g. "Embarque y Trasbordo", quantities are
                           summed, cargo groups joined with " / "
    │
    ▼
BerthCall[]              → validated Pydantic models ready for the optimisation engine
```

### Input → output column mapping

| Input (Spanish CSV) | Output field | Transformation |
|---|---|---|
| `Escala` | `call_id` | string, strip whitespace |
| `Muelle Real` | `berth_id` | string, strip whitespace |
| `Noray Inicio` | `noray_start` | float, nullable |
| `Noray Fin` | `noray_end` | float, nullable |
| `Fecha Atraque Real` | `arrival_time` | datetime (ISO 8601), multi-format fallback |
| `Fecha Desatraque Real` | `departure_time` | datetime (ISO 8601), multi-format fallback |
| `Buque Eslora` | `vessel_length` | float (metres) |
| `Buque GT` | `vessel_gt` | integer |
| `Tipo Operación` | `operation_type` | normalised to `Embarque` / `Desembarque` / `Trasbordo` (or combined e.g. `Embarque y Trasbordo`) |
| `Grupo Mercancía` | `cargo_group` | string |
| `Naturaleza Mercancia` | `cargo_nature` | string |
| `Cantidad` | `quantity` | float, nullable |

### Concurrent-operation merging

When the same vessel (`call_id`) performs two or more operations at the same berth during the exact same time window (identical `arrival_time` and `departure_time`), the rows are merged into one:

| Field | Merge strategy |
|---|---|
| `operation_type` | Types joined in occurrence order: `"Embarque y Trasbordo"` |
| `cargo_group` / `cargo_nature` | Distinct non-empty values joined with `" / "` |
| `quantity` | Sum of all rows (`null` only when every row is null) |
| All other fields | Kept from the first row (vessel dimensions, norays, dates) |

---

## Optimizer

Three-phase scheduling algorithm that minimises total vessel waiting time.  The port configuration (berths, pilots, tugs) is supplied by the caller on every request — the system is **fully configuration-agnostic**.

Vessels are partitioned by ETA date and optimised one day at a time.  Berth states carry forward between days (a vessel docked on day N still occupies space on day N+1); resource pools (pilots, tugs) reset each day, matching per-shift crewing assumptions.

### Phase 1 — Calibration (optional)

`Calibration(csv_path=None)` learns statistical duration models from a historical CSV.  Four generic models are built — no berth names are ever stored:

| Model | Key | Description |
|---|---|---|
| `rate_model` | `(tipo_operacion, grupo_mercancia)` | Median t/h (used when `cantidad` is known) |
| `duration_model` | `(tipo_operacion, grupo_mercancia, eslora_bucket)` | Median duration in hours (≥ 5 observations required) |
| `overlap_factor_learned` | — | Ratio actual / sum-of-individual for multi-operation port calls |
| `maneuver_model` | `(eslora_bucket, hazardous: bool)` | Median single-manoeuvre duration (h) for docking / undocking |

Eslora buckets: `<80 m`, `80–150 m`, `150–220 m`, `>220 m`.

### Phase 2 — Greedy scheduling

Within each berth, vessels are sorted by **GT descending** (higher gross tonnage docks first). For each vessel:

1. Estimate duration using a three-layer fallback:
   - **Layer 1** (most precise): `duration = cantidad / rate_model`
   - **Layer 2** (fallback): median duration from `duration_model`
   - **Layer 3** (last resort): configurable default (default 48 h)
2. Find the earliest feasible berth slot:
   - `continuous` berths: first free contiguous noray range
   - `discrete` berths: earliest available capacity slot
3. Apply real resource constraints (see below); delay start if not enough pilots or tugs are free at the docking moment

#### Pilot rule

Exactly **1 pilot** is required per vessel per manoeuvre — one event at docking, one at undocking.  A pilot is occupied for the duration returned by `estimate_maneuver_duration(eslora, cargo_group, calibration)` per manoeuvre and then returns to the pool.  If no pilot is free when the vessel is ready to dock, the scheduled start is pushed forward until one becomes available.

#### Tug rule

The number of tugs required is computed by `required_tugs(gt, cargo_group, has_bow_thruster)`:

| GT range | Base tugs |
|---|---|
| GT < 500 | 0 |
| 500 ≤ GT < 3 000 | 1 |
| 3 000 ≤ GT < 10 000 | 2 |
| 10 000 ≤ GT < 40 000 | 3 |
| GT ≥ 40 000 | 4 |

Modifiers applied on top of the base value:

| Condition | Effect |
|---|---|
| `cargo_group` is `"Energético"` or `"Químicos"` (hazardous) | +1 tug |
| `has_bow_thruster = True` | −1 tug (minimum 0) |

The result is always in **[0, 4]**.  Tugs are consumed only during the docking manoeuvre and the undocking manoeuvre, **not** during the full berth stay.  If fewer tugs are available than required, the vessel waits.

#### Resource pool model

Pilot and tug pools use an **interval-based** availability model: each unit tracks a list of non-overlapping busy intervals.  This correctly handles the two-event consumption pattern — a unit booked for docking at 08:00–09:00 and pre-booked for undocking at 32:00–33:00 is correctly reported as free in the intervening window.  `ResourcePool.copy()` enables the local search to branch pool state without mutating the caller's pools.

When a vessel's docking is delayed by a resource shortage, the responsible resource type (`pilot_caused_delay`, `tug_caused_delay`) is flagged on the assignment for KPI reporting.  `pilot_wait_h` and `tug_wait_h` record the actual hours attributable to each resource type.

### Phase 3 — Local search (intra-berth swap, resource-aware)

Tries all pairwise permutations within each berth.  A swap is accepted only when:
- It does not violate the GT priority rule (higher GT cannot follow lower GT if both vessels were simultaneously available)
- It strictly reduces **total waiting time** for the group — including resource-induced delays

Resource awareness is achieved via **background pools**: before optimising each berth, pilot/tug pools are pre-loaded with all manoeuvre commitments from the other berths' current-best schedules.  Each candidate ordering is simulated against these background pools (deep-copied per simulation so allocations never cross-contaminate).  This prevents the local search from accepting swaps that reduce berth wait but create resource conflicts against other berths.

**Stopping criteria**: 500 iterations or no improvement in the last 50 iterations.

### Dynamic re-planning (`/replan`)

Re-plans the schedule after one or more vessel delays without discarding the full prior schedule.

**Steps:**
1. Apply the delay to the affected vessel(s): `arrival` delays extend the fondeo phase; `operation` delays extend `estimated_duration_h`; `early_arrival` delays move the ETA backwards.
2. Run conflict detection (`conflict.py`) — checks for berth, pilot, and tug violations.
3. **No conflict** → fondeo absorbed the delay; return the updated schedule as-is.
4. **Conflict** → partial re-run: only the affected berth(s) are re-optimised; all other berths remain frozen.

The response includes `replan_triggered`, `vessels_affected`, `conflicts_found`, and a `delay_map` used by the frontend to render red delay segments in the Gantt.

### Early cargo-operation completion (`/early_complete`)

Called when a vessel finishes cargo before its scheduled end.

**Steps:**
1. Truncate the `ejecucion` phase to the actual completion time.
2. Find the earliest undocking slot respecting pilot and tug availability; insert a `waiting_undock` phase (light purple in the Gantt) if resources are busy.
3. Update `desatraque` and `scheduled_end`.
4. **Cascade pull-forward**: if the berth is freed significantly earlier, vessels waiting in fondeo for this berth are advanced to the earliest feasible slot respecting resource availability.

### Conflict detection (`conflict.py`)

`detect_conflicts(assignments, delays_map, config)` scans the updated schedule for:

| Conflict type | Condition |
|---|---|
| `berth` | Two vessels at the same berth have overlapping `[scheduled_start, scheduled_end)` windows |
| `pilot` | More than `num_pilots` vessels have overlapping docking/undocking manoeuvre windows |
| `tug` | The sum of `tugs_required` across overlapping manoeuvre windows exceeds `num_tugs` |

### Request formats

**`/run`**
```json
{
  "vessels": [
    {
      "id": "T202200020",
      "eta": "2024-01-15T08:00:00",
      "eslora": 144.56,
      "gt": 7680,
      "target_berth": "05 ARAGO",
      "has_bow_thruster": false,
      "operations": [
        { "tipo_operacion": "Desembarque", "grupo_mercancia": "Energético", "cantidad": 25000 }
      ],
      "estimated_duration_h": null
    }
  ],
  "config": {
    "num_pilots": 3,
    "num_tugs": 2,
    "default_duration_h": 48,
    "overlap_factor": 0.70,
    "mooring_zones": [
      { "berth_id": "05 ARAGO", "bap_type": "continuous", "noray_max": 53 },
      { "berth_id": "17 QUIMICA 4", "bap_type": "discrete", "capacity": 2 }
    ]
  }
}
```

**`/replan`**
```json
{
  "base_assignments": [ /* current schedule from /run or prior /replan */ ],
  "delays": [
    { "vessel_id": "T202200020", "delay_h": 3.5, "delay_type": "arrival" }
  ],
  "config": { /* same as /run config */ },
  "vessels": [ /* original vessel inputs */ ]
}
```

`delay_type` values: `"arrival"` (vessel delayed at sea) · `"operation"` (cargo operation running long) · `"early_arrival"` (vessel arrived before ETA).

**`/early_complete`**
```json
{
  "vessel_id": "T202200020",
  "complete_time": "2024-01-15T18:30:00",
  "base_assignments": [ /* current schedule */ ],
  "config": { /* same as /run config */ },
  "vessels": [ /* original vessel inputs */ ]
}
```

### Response format (`/run`)

```json
{
  "assignments": [
    {
      "vessel_id": "T202200020",
      "berth_id": "05 ARAGO",
      "noray_start": 1,
      "noray_end": 13,
      "scheduled_start": "2024-01-15T08:00:00",
      "scheduled_end": "2024-01-16T05:49:00",
      "waiting_time_h": 0.0,
      "duration_estimated_h": 45.8,
      "duration_source": "rate_model",
      "pilot_assigned": true,
      "tugs_required": 3,
      "tugs_assigned": true,
      "status": "assigned",
      "pilot_caused_delay": false,
      "tug_caused_delay": true,
      "pilot_wait_h": 0.0,
      "tug_wait_h": 1.5,
      "caused_delay_to": [],
      "phases": [
        { "name": "fondeo",     "start": "2024-01-15T08:00:00", "end": "2024-01-15T08:00:00", "duration_h": 0.0 },
        { "name": "atraque",    "start": "2024-01-15T08:00:00", "end": "2024-01-15T08:30:00", "duration_h": 0.5 },
        { "name": "ejecucion",  "start": "2024-01-15T08:30:00", "end": "2024-01-16T05:19:00", "duration_h": 44.8 },
        { "name": "desatraque", "start": "2024-01-16T05:19:00", "end": "2024-01-16T05:49:00", "duration_h": 0.5 }
      ]
    }
  ],
  "kpis": {
    "total_waiting_time_h": 0.0,
    "avg_waiting_time_h": 0.0,
    "berth_utilization": { "05 ARAGO": 12.3 },
    "unresolved_vessels": 0,
    "improvement_vs_greedy_pct": 8.3,
    "conflicts_resolved": 1,
    "duration_source_breakdown": { "rate_model": 1 },
    "resource_delays": { "pilot_caused": 0, "tug_caused": 1 }
  }
}
```

#### Operation phases

Each assigned vessel includes a `phases` list.  Standard phases:

| Phase name | Description |
|---|---|
| `fondeo` | Waiting at anchor — from ETA to `scheduled_start` |
| `atraque` | Docking manoeuvre |
| `ejecucion` | Cargo operation |
| `desatraque` | Undocking manoeuvre |

Additional phases inserted by re-planning / early-completion:

| Phase name | Description |
|---|---|
| `delay` | Red segment — visual marker for arrival or operation delay |
| `waiting_undock` | Light-purple segment — vessel waits at berth for undocking resources |
| `early_arrival` | Cyan segment — vessel arrived before its ETA |

#### KPI fields

| Field | Description |
|---|---|
| `total_waiting_time_h` | Sum of all vessel waiting times after local search |
| `avg_waiting_time_h` | Mean waiting time per assigned vessel |
| `berth_utilization` | Per-berth occupancy percentage over the scheduling window |
| `unresolved_vessels` | Count of `unassigned` + `invalid_berth` assignments |
| `improvement_vs_greedy_pct` | Waiting time reduction achieved by local search vs. greedy baseline |
| `conflicts_resolved` | Vessels whose start was pushed back due to resource contention |
| `duration_source_breakdown` | Count of assignments per duration estimation method |
| `resource_delays.pilot_caused` | Vessels delayed specifically by pilot unavailability |
| `resource_delays.tug_caused` | Vessels delayed specifically by tug unavailability |

---

## AIS Stream Relay

Real-time vessel tracking for the Dashboard map.  The FastAPI backend acts as a **WebSocket proxy** between [aisstream.io](https://aisstream.io/) and the Angular dashboard: one persistent upstream connection relays `PositionReport` messages to every connected browser client simultaneously, so only one AISStream API key slot is consumed regardless of the number of open tabs.

### Architecture

```
aisstream.io  ──wss──►  _relay_loop() task  ──fan-out──►  Angular client 1
                                                       └──►  Angular client 2
                                                       └──►  Angular client N
```

The relay is a single `asyncio.Task` (`_relay_loop`) that lives for the lifetime of the server process.  It starts automatically when the first Angular client connects to `/ws/ais-stream` and keeps running even if all clients disconnect (so reconnecting is instant).

### Bounding-box protocol

The frontend sends a `bbox` message to restrict which vessels are streamed.  The relay reconnects to AISStream with the new bounding box after a **1 s debounce**.

```json
{ "type": "bbox", "bbox": [[[swLat, swLng], [neLat, neLng]]] }
```

Default bbox covers the Las Palmas port area: `[[[28.06, -15.52], [28.18, -15.36]]]`.

### Reconnect / backoff

| Event | Behaviour |
|---|---|
| AISStream closes connection | Relay reconnects immediately; backoff starts at 2 s and doubles up to 60 s on repeated failures |
| Backoff reset | On every successful connection, `backoff` resets to 2 s |

---

## Tests

```bash
pytest -v
```

**85 tests** across ten test modules:

| File | Tests | Coverage |
|---|---|---|
| `test_validator.py` | 8 | Schema validation, missing columns, rename correctness |
| `test_cleaner.py` | 7 | Empty row removal, deduplication, whitespace stripping |
| `test_normalizer.py` | 20 | Date format fallbacks, type coercion, operation_type mapping |
| `test_duration.py` | 6 | Three-layer fallback, multi-op overlap, provided override |
| `test_scheduler.py` | 7 | GT priority, invalid berth, continuous noray no-overlap, tug contention delay |
| `test_resources.py` | 15 | `required_tugs` GT table + modifiers, `ResourcePool` interval gaps, multi-unit allocation |
| `test_local_search.py` | 3 | Never worsens, GT constraint respected |
| `test_optimizer.py` | 8 | End-to-end: 2 berths, 20 berths, dynamic KPIs, calibration injection |
| `test_maneuver_duration.py` | 5 | `maneuver_model` lookup, fallbacks (no calibration / missing bucket), end-to-end coherence |
| `test_phases.py` | 6 | Phase sum invariant, ejecucion never negative, zero-wait fondeo, name order, consecutive timestamps, unassigned empty |

**Performance**: 200 vessels / 100 berths → < 0.1 s (target: < 2 s).

---

## Project structure

```
portoptim-backend/
├── main.py                          FastAPI entry point
├── requirements.txt
├── .env.example
├── app/
│   ├── config.py                    pydantic-settings configuration
│   ├── core/
│   │   └── exceptions.py            Custom HTTP exceptions and handlers
│   ├── api/
│   │   └── v1/
│   │       └── routes/
│   │           ├── transformer.py   POST /api/v1/transform/
│   │           └── ais_stream.py    WebSocket /ws/ais-stream — AISStream.io relay
│   ├── models/
│   │   ├── vessel.py                Vessel Pydantic model
│   │   └── berth_call.py            BerthCall Pydantic model (computed duration_hours)
│   ├── services/
│   │   └── transformer/
│   │       ├── validator.py         Schema validation and column renaming
│   │       ├── cleaner.py           Deduplication, empty rows, whitespace, concurrent-op merge
│   │       ├── normalizer.py        Date parsing, type coercion, vocabulary mapping
│   │       └── transformer_service.py  Pipeline orchestrator (6 stages)
│   └── utils/
│       └── csv_reader.py            CSV/Excel reader with encoding fallback
├── optimizer/                       ← Scheduling optimisation engine
│   ├── __init__.py                  Public exports
│   ├── models.py                    Pydantic I/O models (OptimizationRequest/Response,
│   │                                ReplanRequest/Response, EarlyCompleteRequest/Response,
│   │                                VesselDelay), AssignmentResult dataclass,
│   │                                OperationPhase dataclass, build_phases(),
│   │                                required_tugs() business-rule function
│   ├── calibration.py               Phase 1: rate_model, duration_model, overlap_factor,
│   │                                maneuver_model, get_maneuver_duration()
│   ├── duration.py                  Three-layer duration estimator
│   ├── scheduler.py                 Phase 2: greedy scheduler, interval-based ResourcePool
│   │                                (with .copy() for LS branching), pilot/tug resource logic
│   ├── local_search.py              Phase 3: resource-aware intra-berth swap heuristic;
│   │                                background pools prevent resource-conflicting swaps
│   ├── conflict.py                  Conflict detection for re-planning: apply_delays_to_assignments(),
│   │                                detect_conflicts() (berth / pilot / tug)
│   ├── optimizer.py                 Day-by-day orchestrator: optimize(), replan(),
│   │                                early_complete(); KPI computation; visual delay/
│   │                                early-arrival/waiting_undock phase injection
│   └── router.py                    FastAPI router (POST /run, /replan, /early_complete,
│                                    GET /calibration-stats, POST /calibrate)
└── tests/
    ├── conftest.py
    ├── fixtures/
    │   └── sample_port_data.csv
    ├── test_transformer/
    │   ├── test_validator.py
    │   ├── test_cleaner.py
    │   └── test_normalizer.py
    └── test_optimizer/
        ├── conftest.py
        ├── test_duration.py
        ├── test_scheduler.py
        ├── test_resources.py
        ├── test_local_search.py
        ├── test_optimizer.py
        ├── test_maneuver_duration.py
        └── test_phases.py
```

---

## Related

- **portoptim** — Angular frontend that consumes this API ([see frontend README](../portoptim/README.md))

---

## Author

**Aythami Pérez Vega**  
Grado en Ingeniería Informática · Universidad de Las Palmas de Gran Canaria  
Tutores: **Nelson Monzón** · **Christopher Expósito Izquierdo**
