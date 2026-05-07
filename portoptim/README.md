# portoptim — Frontend

Angular web interface for the **PortOptim** maritime berth scheduling system, developed as part of a Final Degree Project (TFG) in Computer Engineering at the Universidad de Las Palmas de Gran Canaria.

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

Tokens follow the Material Design 3 colour-role naming convention and are defined as Tailwind `extend.colors` values in `tailwind.config.js`.

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

### Spacing

Custom Tailwind spacing scale: `xs = 4 px`, `sm = 8 px`, `base = 8 px`, `md = 16 px`, `lg = 24 px`, `xl = 32 px`, `gutter = 24 px`.

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
   declares: LayoutComponent, SidebarComponent, TopbarComponent, TranslatePipe
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
   └─ OptimizationModule     → /optimization
       OptimizationComponent
       VesselDetailPanelComponent
```

All feature routes are **lazy-loaded** (`loadChildren` with dynamic `import()`).  The default route redirects to `/dashboard`.

### Reactive state management

Three singleton stores (no NgRx — plain RxJS `BehaviorSubject`s) share state across pages:

| Service | Type | Purpose |
|---|---|---|
| `TransformationStoreService` | `BehaviorSubject<TransformApiResponse \| null>` | Last successful data transformation result |
| `OptimizationParamsStoreService` | `BehaviorSubject<OptimizationParams \| null>` | User-entered pilots / tugs / mooring zone config |
| `OptimizationResultStoreService` | `BehaviorSubject<OptimizationApiResult \| null>` | Last optimizer run result |

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

24-hour swim-lane Gantt chart driven by `TransformationStoreService`.

- **Day navigation**: collects every calendar day spanned by any vessel (arrival → departure), displays them as a navigable list. Defaults to today if the dataset contains today; otherwise defaults to the last available day.
- **Navigation bar** (top-right):
  - *Viewing today*: `[PREVIOUS DAY]` · `[TODAY]` · `[NEXT DAY]`
  - *Not on today*: `[Go to Today]` · `[PREVIOUS DAY]` · *(date label)* · `[NEXT DAY]`
  - Navigation buttons disabled at the boundaries of the available date range.
- **Swim-lane algorithm** (`assignLanes`): earliest-free-lane assignment; `LANE_PX = 44 px` per lane. Vessels that span multiple days are included in every day they overlap.
- **Clip indicators**: vessels that start before midnight get a `keyboard_double_arrow_left` icon; vessels that end after midnight get `keyboard_double_arrow_right`. Corner rounding adapts accordingly (`rounded-l-lg`, `rounded-r-lg`, `rounded-none`).
- **Consistent colours**: vessel colour is derived from a hash of `call_id` → 6-colour palette (teal, indigo, amber, violet, sky, rose).
- **"Now" line**: a green vertical line (`bg-green-500`) shows the current time of day. Computed using `calc(ratio × 100% + (1 − ratio) × 7rem)` to align correctly with the label column width. Updates every **60 seconds** via `interval(60_000).pipe(startWith(0))`. Only rendered when the selected day is today (`isToday`).
- **Scrollable rows**: `max-h-[480px] overflow-y-auto` so the time axis header stays fixed while many berths scroll.

#### Terminal Map (`TerminalMapComponent`)

Interactive satellite map powered by **Leaflet**, showing live vessel positions from the AIS relay.

**Map layers**:
- Base: Esri World Imagery (satellite tiles)
- Overlay: CartoDB light-only labels (custom pane, `zIndex 450`, pointer-events none)

**AIS vessel markers**:
- SVG arrow polygon icon rotated to `TrueHeading` (degrees); 511 = "not available" → no rotation.
- Colour by `NavigationalStatus`:

  | Status | Meaning | Colour |
  |---|---|---|
  | 0, 8 | Under way | Green `#22c55e` |
  | 1 | At anchor | Yellow `#eab308` |
  | 5 | Moored | Blue `#3b82f6` |
  | other / null | — | Grey `#94a3b8` |

- Marker popup shows: ship name, MMSI, SOG (kn), heading (°), navigational status.
- **Position buffering**: positions are buffered in a `Map<mmsi, AisVesselPosition>`; first flush after 3 s, then every 20 s, to batch Leaflet DOM operations.
- **Stale purge**: markers not updated in the last **10 minutes** are removed (`STALE_MS = 600_000`).
- **Out-of-bounds removal**: vessels outside the current map bounds are removed on every `moveend`.

**Bbox filtering**:
- On `moveend`, the map bounds are sent to the backend after a **1-second debounce** (`bboxSubject.pipe(debounceTime(1000))`).
- A 4-second single-shot flush follows so new-area vessels appear promptly after panning.

**Port search** (Nominatim geocoding):
- Autocomplete dropdown with **350 ms debounce** on keystrokes; shows up to 5 results.
- `Enter` key selects the top suggestion or falls back to a direct geocode search.
- `map.flyTo()` animates to the chosen location at zoom 14.
- "Not found" indicator auto-dismisses after 3 s.

#### Action Alerts (`ActionAlertsComponent`)

Static UI panel showing prioritised operational alerts (critical / info / notice). Placeholder content.

---

### 2. Data Input (`/data-input`)

Single-page form for uploading raw port data and configuring optimizer parameters.

#### File upload

- Drag-and-drop zone or file picker; accepts `.csv` and `.xlsx` (max 50 MB).
- Calls `PortOptimApiService.transformFile()` (multipart POST to `/api/v1/transform/`).
- Shows a spinner during upload; displays server error messages on failure.

#### Transformed preview table

Displays the first **10 valid rows** after a successful transform. Columns:

`Call ID` · `Berth` · `Berthing` · `Unberthing` · `LOA (m)` · `GT` · `Op. Type` · `Cargo Group` · `Quantity` · `Duration (h)`

#### Transformation Summary card

| Field | Source |
|---|---|
| Total input rows | `transformation_summary.total_input_rows` |
| Valid records | `transformation_summary.valid_rows` |
| Skipped rows | `transformation_summary.skipped_rows` |
| Berths | count of unique `berth_id` values |
| Skip reasons | `transformation_summary.skipped_reasons[]` (collapsible list) |

"Proceed to Optimization" button navigates to `/optimization` and persists params via `OptimizationParamsStoreService`.

#### Optimization Parameters panel

Collects the configuration required by the optimizer:

| Field | Type | Validation |
|---|---|---|
| No. of Pilots | number input | required, ≥ 1 |
| No. of Tugs | number input | required, ≥ 1 |
| Berths (mooring zones) | dynamic card list | auto-populated from unique berth IDs |

Each berth card has a **BAP type toggle** (`Continuous` / `Discrete`):
- **Continuous**: requires `noray_max` (integer ≥ 1) — contiguous noray range.
- **Discrete**: requires `capacity` (integer ≥ 1) — number of discrete slots.

A validation error banner lists all incomplete fields and prevents navigation until resolved.

---

### 3. Optimization (`/optimization`)

Dual-mode page: **Historical view** (raw transform data) and **Optimizer view** (proposed schedule).

#### Mode switching

| Mode | Trigger | Data source |
|---|---|---|
| Historical | Transform data loaded, no optimizer result | `TransformationStoreService` |
| Optimizer | After a successful `runOptimization()` call | `OptimizationResultStoreService` |

`resetOptimizer()` (Re-run button) clears the result store and reverts to Historical mode.

#### KPI cards

**Historical mode:**

| Card | Value |
|---|---|
| Vessels | total `BerthCall` records |
| Berths | unique `berth_id` count |
| Avg. Duration | mean `duration_hours` |
| Skipped | `skipped_rows` from summary |

**Optimizer mode:**

| Card | Value | Positive condition |
|---|---|---|
| Total Waiting Time | sum of `waiting_time_h` | < 1 h |
| Avg. Waiting Time | mean `waiting_time_h` | < 1 h |
| Improvement vs. Greedy | `improvement_vs_greedy_pct` % | ≥ 0 % |
| Unresolved Vessels | `unresolved_vessels` count | = 0 |

#### Optimizer extras (shown only in Optimizer mode)

- **Berth Utilization**: horizontal percentage bars per berth, sorted descending, scrollable.
- **Duration Source Breakdown**: pill badges showing count per estimation method (`provided`, `rate_model`, `statistical_model`, `default`).
- **Conflicts Resolved**: single count from `kpis.conflicts_resolved`.

#### Gantt chart

**5-day sliding window** navigation. Windows are computed from the earliest vessel start time; each window spans exactly 5 calendar days.

- **Time axis**: one label per day in the window (`weekday short, day, month` in `es-ES` locale).
- **Navigation bar**: window label (`1 ene – 5 ene`), prev/next buttons, disabled at boundaries.
- **Swim-lane system**: same `assignLanes()` algorithm as the dashboard, `LANE_PX = 44 px`.
- **Clip indicator**: `keyboard_double_arrow_right` icon + `rounded-l-lg` for vessels whose end time exceeds the window right edge.
- **Vessel colours**:
  - Historical mode: rotating 6-colour palette indexed by insertion order.
  - Optimizer mode: same palette for `assigned` vessels; `bg-red-400/70` for `unassigned`.
- **Click handler**: opens `VesselDetailPanelComponent` as a slide-over panel (different data fields depending on mode).

#### Vessel Detail Panel (`VesselDetailPanelComponent`)

Slide-over panel (500 px wide, fixed right, `z-50`) triggered by clicking a Gantt vessel block.

**Always shown:**
- Vessel name, IMO-style sub-label, status chip, priority chip.
- Vessel details: type, LOA (m), GT, operation type.
- Assigned berth block with ETA / ETD.
- Cargo list (icon, type, quantity, unit).

**Optimizer mode only** (when `optimizerStatus` is set):

| Field | Description |
|---|---|
| Waiting Time | `waiting_time_h` formatted to 2 dp; green if 0, amber otherwise |
| Est. Duration | `duration_estimated_h` in hours |
| Duration Source | `rate_model` → "Rate model", `statistical_model` → "Statistical", etc. |
| Status badge | `assigned` (teal) / `unassigned` (amber) / `invalid_berth` (red) |
| Pilot | Check / cancel icon based on `pilot_assigned` |
| Tugs | `do_not_disturb_on` if 0 required; check / cancel icon + count if > 0 |

---

## Core services

### `PortOptimApiService`

| Method | HTTP | Endpoint | Description |
|---|---|---|---|
| `transformFile(file)` | `POST` | `/api/v1/transform/` | Multipart upload → `TransformApiResponse` |
| `runOptimization(req)` | `POST` | `/api/v1/optimize/run` | Schedule optimizer → `OptimizationApiResult` |

Base URL: `http://localhost:8000`. Error responses extract `detail` from the server JSON body.

### `AisStreamService`

Manages the WebSocket connection to the backend AIS relay at `ws://localhost:8000/ws/ais-stream`.

| Member | Type | Description |
|---|---|---|
| `positions$` | `Observable<AisVesselPosition>` | Emits each parsed PositionReport |
| `status$` | `Observable<'live' \| 'reconnecting'>` | Connection state |
| `connect()` | — | Open socket; auto-reconnects on close (exponential backoff, max 30 s) |
| `disconnect()` | — | Close socket, cancel pending reconnect |
| `sendBbox(sw, ne)` | — | Send `{type:'bbox', bbox:[[[swLat,swLng],[neLat,neLng]]]}` to filter area |

`AisVesselPosition` fields: `mmsi`, `shipName`, `latitude`, `longitude`, `sog`, `heading` (null if 511), `navStatus`, `timeUtc`.

### `LanguageService`

Client-side i18n. Backed by `BehaviorSubject<LangCode>`.

| Member | Description |
|---|---|
| `lang$` | Observable language code changes |
| `current` | Getter — current `LangCode` |
| `set(lang)` | Switch language; all `translate` pipes update automatically |
| `t(key)` | Translate a key to the current language; returns the key itself if not found |

### Store services

All three follow the same `BehaviorSubject` pattern:

| Service | Stored type | Used by |
|---|---|---|
| `TransformationStoreService` | `TransformApiResponse \| null` | Dashboard, DataInput, Optimization |
| `OptimizationParamsStoreService` | `OptimizationParams \| null` | DataInput, Optimization |
| `OptimizationResultStoreService` | `OptimizationApiResult \| null` | Optimization |

Each exposes `result$` (Observable), `snapshot` (getter), `set()`, and `clear()`.

---

## API models (`core/models/api.models.ts`)

### Data transformation

```typescript
interface BerthCall {
  call_id: string;
  berth_id: string;
  arrival_time: string;        // ISO 8601
  departure_time: string;      // ISO 8601
  vessel_length: number;       // metres
  vessel_gt: number;
  operation_type: string;
  cargo_group: string;
  cargo_nature: string;
  quantity: number | null;
  duration_hours: number;
  noray_start: number | null;
  noray_end: number | null;
}

interface TransformationSummary {
  total_input_rows: number;
  valid_rows: number;
  skipped_rows: number;
  skipped_reasons: string[];
}

interface TransformApiResponse {
  transformation_summary: TransformationSummary;
  available_ports: string[];
  data: BerthCall[];
}
```

### Optimization input

```typescript
type BapType = 'continuous' | 'discrete';

interface MooringZoneConfig {
  berth_id: string;
  bap_type: BapType;
  noray_max?: number;   // continuous only
  capacity?: number;    // discrete only
}

interface VesselOperationInput {
  tipo_operacion: string;
  grupo_mercancia: string;
  cantidad: number | null;
}

interface VesselInput {
  id: string;
  eta: string;
  eslora: number;
  gt: number;
  target_berth: string;
  operations: VesselOperationInput[];
  estimated_duration_h: number | null;
}

interface OptimizationApiRequest {
  vessels: VesselInput[];
  config: {
    num_pilots: number;
    num_tugs: number;
    default_duration_h: number;
    overlap_factor: number;
    mooring_zones: MooringZoneConfig[];
  };
}
```

### Optimization output

```typescript
type AssignmentStatus = 'assigned' | 'unassigned' | 'invalid_berth';
type DurationSource   = 'provided' | 'rate_model' | 'statistical_model' | 'default';

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
  caused_delay_to: string[];
}

interface OptimizationKpis {
  total_waiting_time_h: number;
  avg_waiting_time_h: number;
  berth_utilization: Record<string, number>;
  unresolved_vessels: number;
  improvement_vs_greedy_pct: number;
  conflicts_resolved: number;
  duration_source_breakdown: Record<DurationSource, number>;
  resource_delays: { pilot_caused: number; tug_caused: number };
}

interface OptimizationApiResult {
  assignments: OptimizationAssignment[];
  kpis: OptimizationKpis;
}
```

---

## Internationalisation

Custom client-side system — no Angular i18n builder.

| Language | Code |
|---|---|
| English | `en` |
| Español | `es` |
| Deutsch | `de` |
| Français | `fr` |

**How it works:**

- `translations.ts` exports a `Record<LangCode, Record<string, string>>` with ~200 keys per language (~800 translations total).
- Keys use dot notation grouped by feature: `topbar.*`, `sidebar.*`, `nav.*`, `di.*`, `dash.*`, `timeline.*`, `opt.*`, `vessel.*`, `alerts.*`.
- `LanguageService` holds the active language in a `BehaviorSubject`.
- `TranslatePipe` (`pure: false`) calls `LanguageService.t(key)` on every change-detection cycle — this ensures instant UI updates when the language is switched.
- Language switcher lives in `TopbarComponent` (dropdown).
- In TypeScript code, `this.lang.t('key')` is used directly (e.g. validation error messages).

---

## External integrations

| Service | Protocol | Purpose |
|---|---|---|
| PortOptim backend | HTTP REST | Data transformation, schedule optimization |
| PortOptim backend | WebSocket | AIS position relay (`/ws/ais-stream`) |
| Esri ArcGIS | HTTPS (tile) | Satellite base map |
| CartoDB | HTTPS (tile) | Place-name label overlay |
| Nominatim (OSM) | HTTPS (JSON) | Port / place geocoding for map search |

---

## Project structure

```
portoptim/
├── src/
│   ├── app/
│   │   ├── app.component.ts/html          Root component (empty shell)
│   │   ├── app-routing.module.ts          Root routes + lazy-load declarations
│   │   ├── app.module.ts                  AppModule (BrowserModule, HttpClient, Shared)
│   │   │
│   │   ├── core/
│   │   │   ├── i18n/
│   │   │   │   └── translations.ts        ~800 translation strings (en/es/de/fr)
│   │   │   ├── models/
│   │   │   │   └── api.models.ts          All TypeScript API interfaces
│   │   │   └── services/
│   │   │       ├── language.service.ts           Active language + t() helper
│   │   │       ├── portoptim-api.service.ts       HTTP client (transform + optimize)
│   │   │       ├── transformation-store.service.ts
│   │   │       ├── optimization-params-store.service.ts
│   │   │       └── optimization-result-store.service.ts
│   │   │
│   │   ├── shared/
│   │   │   ├── components/
│   │   │   │   ├── sidebar/               Nav links (Dashboard, Data Input, Optimization)
│   │   │   │   ├── topbar/                Title, language switcher, help modal
│   │   │   │   └── layout/                Shell: sidebar + topbar + <router-outlet>
│   │   │   ├── pipes/
│   │   │   │   └── translate.pipe.ts      {{ 'key' | translate }} (pure: false)
│   │   │   └── shared.module.ts           Exports layout components + TranslatePipe
│   │   │
│   │   └── features/
│   │       ├── dashboard/
│   │       │   ├── components/
│   │       │   │   ├── metric-card/       KPI card (@Input: title, value, trend, icon)
│   │       │   │   ├── berth-timeline/    24h swim-lane Gantt + "now" line
│   │       │   │   ├── action-alerts/     Static prioritised alert panel
│   │       │   │   └── terminal-map/      Leaflet satellite map + live AIS markers
│   │       │   ├── services/
│   │       │   │   └── ais-stream.service.ts  WebSocket client for AIS relay
│   │       │   ├── dashboard.component.ts/html  Page container + KPI data binding
│   │       │   ├── dashboard.module.ts
│   │       │   └── dashboard-routing.module.ts
│   │       │
│   │       ├── data-input/
│   │       │   ├── data-input.component.ts/html  Upload + preview + params form
│   │       │   ├── data-input.module.ts
│   │       │   └── data-input-routing.module.ts
│   │       │
│   │       └── optimization/
│   │           ├── components/
│   │           │   └── vessel-detail-panel/  Slide-over panel (historical + optimizer)
│   │           ├── optimization.component.ts/html  Dual-mode Gantt + KPIs
│   │           ├── optimization.module.ts
│   │           └── optimization-routing.module.ts
│   │
│   ├── assets/
│   └── styles/                            Global SCSS + CSS variable overrides
│
├── tailwind.config.js                     Custom palette, spacing, typography
├── angular.json
├── package.json
└── README.md
```

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

Open `http://localhost:4200/`. The backend must be running on `http://localhost:8000` for API calls and the AIS WebSocket relay to work.

### Production build

```bash
ng build
```

Compiled artefacts are written to `dist/`. Output hashing is enabled for all assets.

---

## Future work

**Angular / Ionic mobile app**: Angular's compatibility with Ionic Framework means a large portion of the existing component and service logic could be reused to produce a native iOS / Android application without rewriting from scratch. This is outside the current TFG scope but is the natural next step for field use by port operators on mobile devices.

---

## Related

- **portoptim-backend** — Python FastAPI that powers the data transformer, optimisation engine, and AIS WebSocket relay ([see backend README](../portoptim-backend/README.md))

---

## Author

**Aythami Pérez Vega**  
Grado en Ingeniería Informática · Universidad de Las Palmas de Gran Canaria  
Tutores: **Nelson Monzón** · **Christopher Expósito Izquierdo**
