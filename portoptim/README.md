# portoptim — Frontend Angular

Interfaz de usuario de **PortOptim**, desarrollada con Angular 19 como parte de un TFG en Ingeniería Informática (ULPGC).

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | [Angular](https://angular.dev/) 19 (NgModule architecture, `standalone: false`) |
| Language | TypeScript 5.7 |
| Styles | Tailwind CSS 3.4 + SCSS — custom *Maritime Logistics Excellence* design system |
| Maps | [Leaflet](https://leafletjs.com/) 1.9 |
| Reactivity | [RxJS](https://rxjs.dev/) 7.8 (BehaviorSubject stores, Subject streams, operators) |
| Icons | Google Material Symbols (via CDN) |
| Typography | Inter |
| Build tool | Angular CLI 19 / esbuild |
| Testing | Karma + Jasmine |

---

## Design system — Maritime Logistics Excellence

A custom design system built for data-heavy, high-pressure maritime operations interfaces.

### Colour palette

| Role | Token | Hex | Usage |
|---|---|---|---|
| Primary (Navy) | `primary` | `#000a1e` | Sidebar, headers, branding |
| Accent (Teal) | `on-secondary-container` | `#006a6a` | Primary buttons, active states |
| Background | — | `#f8f9ff` | Application background |
| Surface | — | `#ffffff` | Cards and containers |
| Error | `error` | `#ba1a1a` | Validation errors, alert badges |
| Primary container | `primary-container` | custom | Gantt vessel bars, map badge |

### Typography

**Inter** throughout. Custom Tailwind font-size utilities:

| Utility | Size | Weight |
|---|---|---|
| `text-h1` | 32 px | 700 |
| `text-h2` | 24 px | 600 |
| `text-h3` | 20 px | 600 |
| `text-body-lg/md/sm` | 18 / 16 / 14 px | 400 |
| `text-label-md/sm` | 14 / 12 px | 600 |
| `text-data-mono` | 14 px | 500, monospace |

### Layout shell

- Fixed left sidebar: `260 px` wide, Navy background.
- Fixed topbar: `64 px` tall.
- Main content area: `margin-left: 260 px`, `min-height: calc(100vh − 64px)`.
- Base card border-radius: `8 px` (`rounded-xl`). Card shadow: `shadow-card`.

---

## Architecture

### Module structure

```
AppModule
├─ BrowserModule + HttpClientModule + AppRoutingModule
└─ SharedModule  ──────────────────────────────────────────────────────────┐
   declares: LayoutComponent, SidebarComponent, TopbarComponent,
             OptimizationToastComponent, VesselAlertToastComponent, TranslatePipe
                                                                            │
   ┌───────────────── lazy-loaded feature modules ──────────────────────────┘
   │
   ├─ DashboardModule        → /dashboard
   │   DashboardComponent
   │   MetricCardComponent
   │   BerthTimelineComponent
   │   ActionAlertsComponent
   │   TerminalMapComponent
   │
   ├─ DataInputModule        → /data-input
   │   DataInputComponent
   │
   ├─ StatisticsModule       → /statistics
   │   StatisticsComponent
   │
   └─ OptimizationModule     → /optimization
       OptimizationComponent
       VesselDetailPanelComponent
```

All feature routes are **lazy-loaded** (`loadChildren` with dynamic `import()`). The default route redirects to `/dashboard`.

### Reactive state management

Singleton stores (plain RxJS `BehaviorSubject`s) share state across pages without NgRx:

| Service | Type | Purpose |
|---|---|---|
| `TransformationStoreService` | `BehaviorSubject<TransformApiResponse \| null>` | Last successful data transformation result |
| `OptimizationParamsStoreService` | `BehaviorSubject<OptimizationParams \| null>` | User-entered pilots / tugs / mooring zone config |
| `OptimizationResultStoreService` | `BehaviorSubject<OptimizationApiResult \| null>` | Last optimizer run result (shared by Optimization, Statistics, VesselAlertService) |

All services use `@Injectable({ providedIn: 'root' })`.

---

## Pages

### 1. Dashboard (`/dashboard`)

Real-time operational overview. Composed of four sub-components.

#### KPI cards (`MetricCardComponent`)

Reads `TransformationStoreService` and displays four metrics:

| Metric | Source |
|---|---|
| Total Vessels | `data.length` from last transform |
| Active Berths | count of unique `berth_id` values |
| Avg. Duration | mean `duration_hours` across all calls |
| Skipped Rows | `transformation_summary.skipped_rows` |

All metrics show `—` when no dataset is loaded.

#### Berth Allocation Timeline (`BerthTimelineComponent`)

24-hour swim-lane Gantt chart that subscribes to **both** `TransformationStoreService` (historical data) and `OptimizationResultStoreService` (optimizer results), automatically switching between modes.

**Mode switching:**

| Mode | Trigger | Data source | Vessel rendering |
|---|---|---|---|
| Historical | Transform loaded, no optimizer result | `TransformationStoreService` | Solid coloured block per `call_id` hash |
| Optimizer | After optimizer run (`isOptimizerMode = true`) | `OptimizationResultStoreService` | Phase-coloured segments (atraque / ejecucion / desatraque) |

- **Day navigation**: collects every calendar day spanned by any vessel; displays them as a navigable list. Defaults to today if the dataset contains today; otherwise defaults to the last / first available day.
- **Swim-lane algorithm** (`assignLanes`): earliest-free-lane assignment; `LANE_PX = 44 px` per lane.
- **Clip indicators**: vessels that span midnight get directional arrow icons + rounded-corner adaptation.
- **Warning indicators**: in optimizer mode, vessels whose `scheduled_end` has passed but are still listed show an orange ⚠ icon (operation overrun); vessels whose ETA is within [−1 h, +3 h] of now show an amber anchor icon (approaching/arrived).
- **"Now" line**: green vertical line updated every 60 seconds. Only rendered when the selected day is today.

#### Terminal Map (`TerminalMapComponent`)

Interactive satellite map (Leaflet + Esri World Imagery + CartoDB labels) showing live AIS vessel positions. Markers are colour-coded by navigational status, rotate to `TrueHeading`, and auto-purge after 10 minutes without a position update.

#### Action Alerts (`ActionAlertsComponent`)

Static UI panel showing prioritised operational alerts. Placeholder content.

---

### 2. Data Input (`/data-input`)

Single-page form for uploading raw port data and configuring optimizer parameters.

- Drag-and-drop or file-picker upload (`.csv` / `.xlsx`, max 50 MB) → multipart POST to `/api/v1/transform/`.
- Transformed preview table (first 10 valid rows).
- Transformation Summary card: total rows, valid records, skipped rows, skip reasons.
- Optimization Parameters panel: nº pilots, nº tugs, berth mooring-zone definitions (continuous with `noray_max` / discrete with `capacity`).
- Berth live search filter, localStorage config persistence, import/export JSON config.

---

### 3. Statistics (`/statistics`)

In-depth statistical analysis in two independent tabs.

#### Tab toggle

A segmented control switches between **CSV** (historical transform data) and **Optimizer** (last optimizer run). The toggle is only shown once an optimizer result is available.

#### CSV tab

| Chart | Description |
|---|---|
| **KPI cards** | Total vessels · Unique berths · Avg. stay (`hh:mm`) · Date range |
| **Avg. Duration + Cargo Volume by Month** | Dual horizontal-bar chart in a 6-month window with prev/next navigation |
| **Monthly detail panel** | Berth Occupancy · Operation Type breakdown · Cargo Group breakdown |
| **Arrival Distribution** | 24-bucket vertical bar chart of vessel arrivals by hour of day |

#### Optimizer tab

Mirrors the CSV charts for the first three, then adds optimizer-specific panels:

| Chart | Description |
|---|---|
| **KPI cards** | Assigned vessels · Avg. total stay (all phases) · Improvement vs. greedy % |
| **Docking & Undocking Distribution** | 24-column chart with two overlapping bars per hour (sky = atraque starts, violet = desatraque starts). Custom hover tooltip; footer shows peak hour per phase. |
| **Operation Phases** | Horizontal bars for fondeo / atraque / ejecucion / desatraque with total + avg hours |
| **Anchorage by Berth** | Total + avg fondeo hours per berth, sorted by total descending |
| **Waiting Time Distribution** | 5-bucket vertical bar chart (0 h / 0–10 h / 10–20 h / 20–30 h / >30 h) |
| **Duration Sources** | Horizontal bars per estimation method (`provided` / `rate_model` / `statistical_model` / `default`) |
| **Resource Allocation by Month** | FTE-based pilot + tug staffing in a 6-month window. **FTE formula**: `ceil( Σ [ceil(atraque_h) + ceil(desatraque_h)] / available_h )` where `available_h = 48 × (days_in_month / 7)`. Yearly peak chips show the busiest month's headcount. Also shows peak simultaneous usage and resource-induced wait hours (`pilot_wait_h`, `tug_wait_h`). |

---

### 4. Optimization (`/optimization`)

Dual-mode page with a 5-day multi-window Gantt and full dynamic re-planning capabilities.

#### Mode switching

| Mode | Trigger | Data source |
|---|---|---|
| Historical | Transform data loaded, no optimizer result | `TransformationStoreService` |
| Optimizer | After a successful `runOptimization()` call | `OptimizationResultStoreService` |

`resetOptimizer()` (Re-run button) clears the result store and reverts to Historical mode.

#### KPI cards

**Historical mode:** Vessels · Berths · Avg. Duration · Skipped.

**Optimizer mode:**

| Card | Value | Positive condition |
|---|---|---|
| Total Anchorage | sum of `fondeo.duration_h` across all assigned vessels | < 1 h |
| Avg. Anchorage | mean `fondeo.duration_h` per assigned vessel | < 1 h |
| Improvement vs. Greedy | `improvement_vs_greedy_pct` % | ≥ 0 % |
| Unresolved Vessels | `unresolved_vessels` count | = 0 |

Additional optimizer panels: Berth Utilization bars, Duration Source Breakdown pills, Conflicts Resolved count, resource delay counts (`pilot_caused` / `tug_caused`).

#### Gantt — multi-window (5-day)

The Gantt shows **5 days per window**; navigation moves forward or back 5 days at a time. The time axis shows day labels rather than hours.

- **Swim-lane system**: `assignLanes()` algorithm, `LANE_PX = 44 px`, supports concurrent vessels within the same berth.
- **Clip indicators**: arrow icons + rounded-corner adaptation for vessels that start before or end after the window.
- **Phase segment rendering** (optimizer mode):
  - `fondeo` — shown as a semi-transparent amber ⚓ bubble with duration
  - `atraque` — sky-blue segment
  - `ejecucion` — emerald-green segment
  - `desatraque` — indigo segment
  - `delay` — red segment (arrival or operation delay visual marker)
  - `waiting_undock` — light-purple segment (vessel waiting at berth for undocking resources)
  - `early_arrival` — cyan segment (vessel arrived before ETA)
- **Warning icons**: orange ⚠ on vessels whose `scheduled_end` has passed (operation overrun); amber ⚓ on vessels within [ETA − 1 h, ETA + 3 h] (approaching / arrived).
- **Click handler**: opens `VesselDetailPanelComponent`.

#### Dynamic re-planning

Applies a delay to one vessel and calls `POST /api/v1/optimize/replan`.

Three delay types are supported:

| Type | Effect |
|---|---|
| `arrival` | Vessel delayed at sea; ETA pushed forward. If the fondeo buffer absorbs the delay, no berths are re-optimised. |
| `operation` | Cargo operation is running long; `estimated_duration_h` extended. Cascade re-plan if it displaces following vessels. |
| `early_arrival` | Vessel arrived before ETA; the optimizer attempts to dock it sooner. |

Accumulated delays are stored per vessel and sent as totals on each `/replan` call. After each successful re-plan, the base assignments snapshot is updated so subsequent calls compose on top of the latest schedule. A `replan_triggered` flag from the response shows whether a full partial re-optimisation ran or the fondeo buffer was sufficient.

#### Early cargo-operation completion

Calls `POST /api/v1/optimize/early_complete` when a vessel finishes its operation before the scheduled end time.

- Truncates `ejecucion` at the confirmed completion time.
- Checks pilot and tug availability for immediate undocking; inserts a `waiting_undock` phase (light purple) if resources are busy.
- Cascades a pull-forward for any vessel waiting in fondeo for the freed berth.
- Returns `waiting_undock_h` and `berth_freed_delta_h` for display in the detail panel.

#### Vessel Detail Panel (`VesselDetailPanelComponent`)

Slide-over panel (500 px wide, fixed right, `z-50`) triggered by clicking a Gantt vessel block.

Shows vessel metadata, assigned berth, cargo list, and — in optimizer mode — full phase breakdown with a proportional phase colour bar. Footer action buttons advance the operational status: `on_the_way → in_progress → completed`, plus a **Delay** button that opens the delay form and an **Early Complete** button.

---

## Core services

### `PortOptimApiService`

| Method | HTTP | Endpoint | Description |
|---|---|---|---|
| `transformFile(file)` | `POST` | `/api/v1/transform/` | Multipart upload → `TransformApiResponse` |
| `runOptimization(req)` | `POST` | `/api/v1/optimize/run` | Schedule optimizer → `OptimizationApiResult` |
| `replan(req)` | `POST` | `/api/v1/optimize/replan` | Re-plan after delays → `ReplanResponse` |
| `earlyComplete(req)` | `POST` | `/api/v1/optimize/early_complete` | Early completion → `EarlyCompleteResponse` |

Base URL: `http://localhost:8000`.

### `OptimizationRunnerService`

Owns the optimizer API lifecycle so it survives Angular component navigation. Key methods:

| Method | Description |
|---|---|
| `run()` | Calls `/run`, updates result store, shows toast notification |
| `applyDelay(vesselId, delayH, type)` | Accumulates delay and calls `/replan` |
| `confirmEarlyComplete(vesselId, completeTime)` | Calls `/early_complete` and updates base snapshot |
| `resetDelays()` | Clears accumulated delays on optimizer reset |

Exposes `isRunning$`, `isReplanning$`, `showNotification$`, `showReplanNotification$` streams.

### `VesselAlertService`

Singleton that watches the optimization result and computes time-based vessel alerts. Refreshes every 60 seconds and whenever a new result is loaded.

| Alert type | Active window | Trigger |
|---|---|---|
| `arrival` | `[ETA − 1 h, ETA + 3 h]` | Vessel is approaching or has recently arrived |
| `departure` | `[scheduled_end, scheduled_end + 5 h]` | Operation should have ended but vessel is still at berth |

New alerts are emitted once via `newAlert$` so `VesselAlertToastComponent` can present them. Exposes `alerts$`, `unreadCount$`, `hasUnread$`, `markAllRead()`, `dismiss(id)`.

### `AisStreamService`

WebSocket client for the AIS relay at `ws://localhost:8000/ws/ais-stream`. Auto-reconnects with exponential backoff (max 30 s). Sends `bbox` messages to filter area.

### Store services

| Service | Stored type | Used by |
|---|---|---|
| `TransformationStoreService` | `TransformApiResponse \| null` | Dashboard, DataInput, Optimization, Statistics |
| `OptimizationParamsStoreService` | `OptimizationParams \| null` | DataInput, Optimization |
| `OptimizationResultStoreService` | `OptimizationApiResult \| null` | Dashboard, Optimization, Statistics, VesselAlertService |

---

## Shared components

### `TopbarComponent`

Barra superior con:
- Nombre de la ruta activa.
- Selector de idioma (dropdown, 4 idiomas).
- Badge de alertas no leídas (número sobre icono de campana).
- Panel de notificaciones desplegable con lista de alertas activas, opción de marcar todas como leídas y dismiss individual.

### `VesselAlertToastComponent`

Stack de toasts apilados verticalmente (nuevas al fondo). Cada toast:
- Muestra tipo de alerta (llegada / salida), ID del buque y ventana de expiración.
- Se auto-descarta en 6 s con barra de progreso animada.
- Tiene botón de cierre manual con animación de slide-out.
- Simultaneous alerts are all visible at once (one entry per alert).

### `OptimizationToastComponent`

Toast flotante que aparece cuando una optimización o re-planificación finaliza fuera de la página `/optimization`.

### `LayoutComponent`

Shell principal: sidebar fijo + topbar + `<router-outlet>` + `<app-vessel-alert-toast>` + `<app-optimization-toast>`.

---

## API models (`core/models/api.models.ts`)

### Optimization output (updated)

```typescript
interface OptimizationAssignment {
  vessel_id: string;
  berth_id: string;
  noray_start: number | null;
  noray_end: number | null;
  scheduled_start: string;
  scheduled_end: string;
  waiting_time_h: number;
  duration_estimated_h: number;
  duration_source: DurationSource;
  pilot_assigned: boolean;
  tugs_required: number;
  tugs_assigned: boolean;
  status: AssignmentStatus;
  pilot_caused_delay: boolean;
  tug_caused_delay: boolean;
  pilot_wait_h: number;          // fondeo hours attributable to pilot unavailability
  tug_wait_h: number;            // fondeo hours attributable to tug unavailability
  caused_delay_to: string[];
  delay_h?: number;              // total delay applied (from /replan); drives red segment
  early_arrival_h?: number;      // hours arrived early (from /replan early_arrival)
  phases: OperationPhase[];
}

// Phase names include standard + dynamic re-planning phases:
type PhaseName =
  | 'fondeo' | 'atraque' | 'ejecucion' | 'desatraque'  // standard
  | 'delay'                                              // arrival or operation delay (red)
  | 'waiting_undock'                                     // waiting at berth for undock resources (light purple)
  | 'early_arrival';                                     // arrived before ETA (cyan)
```

### Re-planning models

```typescript
interface VesselDelay {
  vessel_id: string;
  delay_h: number;
  delay_type: 'arrival' | 'operation' | 'early_arrival';
}

interface ReplanRequest {
  base_assignments: OptimizationAssignment[];
  delays: VesselDelay[];
  config: OptimizationConfig;
  vessels: VesselInput[];
}

interface ReplanResponse {
  assignments: OptimizationAssignment[];
  kpis: OptimizationKpis;
  replan_triggered: boolean;
  vessels_affected: string[];
  conflicts_found: number;
  delay_map: Record<string, number>;
}
```

### Early-completion models

```typescript
interface EarlyCompleteRequest {
  vessel_id: string;
  complete_time: string;          // ISO 8601 wall-clock time (no 'Z')
  base_assignments: OptimizationAssignment[];
  config: OptimizationConfig;
  vessels: VesselInput[];
}

interface EarlyCompleteResponse {
  assignments: OptimizationAssignment[];
  kpis: OptimizationKpis;
  replan_triggered: boolean;
  waiting_undock_h: number;
  berth_freed_delta_h: number;
}

export interface EarlyCompleteInfo {
  waitingUndockH:   number;
  replanTriggered:  boolean;
  berthFreedDeltaH: number;
}
```

---

## Internationalisation

Custom client-side system — no Angular i18n builder. `translations.ts` exports ~210 keys per language (~840 translations total) including new keys for: `notif.*` (alert types and reasons), `opt.phase.*` (dynamic phase names), `stats.*` (Statistics page charts).

| Language | Code |
|---|---|
| English | `en` |
| Español | `es` |
| Deutsch | `de` |
| Français | `fr` |

`TranslatePipe` (`pure: false`) calls `LanguageService.t(key)` on every change-detection cycle for instant UI updates on language switch.

---

## Project structure

```
portoptim/src/app/
├── app.component.ts/html          Root component
├── app-routing.module.ts          Lazy-load routes
├── app.module.ts
│
├── core/
│   ├── i18n/
│   │   └── translations.ts        ~840 translation strings (en/es/de/fr)
│   ├── models/
│   │   └── api.models.ts          BerthCall, OptimizationAssignment, OperationPhase,
│   │                              ReplanRequest/Response, EarlyCompleteRequest/Response,
│   │                              VesselDelay, VesselAlert (via VesselAlertService)
│   └── services/
│       ├── language.service.ts
│       ├── portoptim-api.service.ts        HTTP client (transform + optimize + replan + early_complete)
│       ├── optimization-runner.service.ts  Lifecycle: run / applyDelay / confirmEarlyComplete / reset
│       ├── optimization-result-store.service.ts
│       ├── optimization-params-store.service.ts
│       ├── transformation-store.service.ts
│       └── vessel-alert.service.ts         Time-based arrival/departure alerts (60 s refresh)
│
├── shared/
│   ├── components/
│   │   ├── layout/                Shell (sidebar + topbar + outlet + toasts)
│   │   ├── topbar/                Alert badge, alert panel, language switcher
│   │   ├── sidebar/               Nav links
│   │   ├── optimization-toast/    Toast for optimizer / replan completion
│   │   └── vessel-alert-toast/    Stack of vessel arrival/departure toasts (6 s auto-dismiss)
│   ├── pipes/
│   │   └── translate.pipe.ts
│   └── shared.module.ts
│
└── features/
    ├── dashboard/
    │   ├── components/
    │   │   ├── berth-timeline/    24 h Gantt with arrival + overrun warning icons
    │   │   ├── metric-card/
    │   │   ├── action-alerts/
    │   │   └── terminal-map/
    │   └── dashboard.component.ts/html
    ├── data-input/
    │   └── data-input.component.ts/html
    ├── statistics/
    │   └── statistics.component.ts/html   CSV tab + Optimizer tab (phases, resources, FTE)
    └── optimization/
        ├── optimization.component.ts/html  5-day Gantt + replanning + early complete + KPIs
        └── components/
            └── vessel-detail-panel/        Slide-over with phases, delay form, early-complete
```

---

## External integrations

| Service | Protocol | Purpose |
|---|---|---|
| PortOptim backend | HTTP REST | Data transformation, schedule optimization, re-planning, early completion |
| PortOptim backend | WebSocket | AIS position relay (`/ws/ais-stream`) |
| Esri ArcGIS | HTTPS (tile) | Satellite base map |
| CartoDB | HTTPS (tile) | Place-name label overlay |
| Nominatim (OSM) | HTTPS (JSON) | Port / place geocoding for map search |

---

## Installation and setup

### Prerequisites

- Node.js ≥ 18
- Angular CLI ≥ 19

```bash
npm install -g @angular/cli
```

### Development

```bash
cd portoptim
npm install
ng serve
```

Open `http://localhost:4200/`. The backend must be running on `http://localhost:8000`.

### Production build

```bash
ng build
```

Compiled artefacts are written to `dist/`.

---

## Related

- **portoptim-backend** — Python FastAPI that powers the data transformer, optimisation engine, re-planning, early-completion, and AIS WebSocket relay ([see backend README](../portoptim-backend/README.md))

---

## Author

**Aythami Pérez Vega**  
Grado en Ingeniería Informática · Universidad de Las Palmas de Gran Canaria  
Tutores: **Nelson Monzón** · **Christopher Expósito Izquierdo**
