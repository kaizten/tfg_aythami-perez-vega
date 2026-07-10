# portoptim — Frontend Angular

Interfaz de usuario de **PortOptim**, desarrollada con Angular 19 como parte de un TFG en Ingeniería Informática (ULPGC).

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Framework | [Angular](https://angular.dev/) 19 (arquitectura NgModule, `standalone: false`) |
| Lenguaje | TypeScript 5.7 |
| Estilos | Tailwind CSS 3.4 + SCSS — sistema de diseño propio *Maritime Logistics Excellence* |
| Mapas | [Leaflet](https://leafletjs.com/) 1.9 |
| Reactividad | [RxJS](https://rxjs.dev/) 7.8 (stores con BehaviorSubject, streams Subject, operadores) |
| Iconos | Google Material Symbols (vía CDN) |
| Tipografía | Inter |
| Herramienta de build | Angular CLI 19 / esbuild |
| Testing | Karma + Jasmine |

---

## Sistema de diseño — Maritime Logistics Excellence

Sistema de diseño propio, construido para interfaces de operaciones marítimas con mucha densidad de datos y alta presión operativa.

### Paleta de colores

| Rol | Token | Hex | Uso |
|---|---|---|---|
| Primario (Navy) | `primary` | `#000a1e` | Sidebar, cabeceras, marca |
| Acento (Teal) | `on-secondary-container` | `#006a6a` | Botones primarios, estados activos |
| Fondo | — | `#f8f9ff` | Fondo de la aplicación |
| Superficie | — | `#ffffff` | Tarjetas y contenedores |
| Error | `error` | `#ba1a1a` | Errores de validación, badges de alerta |
| Contenedor primario | `primary-container` | personalizado | Barras de buques en el Gantt, badge del mapa |

### Tipografía

**Inter** en toda la aplicación. Utilidades de tamaño de fuente personalizadas en Tailwind:

| Utilidad | Tamaño | Peso |
|---|---|---|
| `text-h1` | 32 px | 700 |
| `text-h2` | 24 px | 600 |
| `text-h3` | 20 px | 600 |
| `text-body-lg/md/sm` | 18 / 16 / 14 px | 400 |
| `text-label-md/sm` | 14 / 12 px | 600 |
| `text-data-mono` | 14 px | 500, monoespaciada |

### Estructura de layout

- Sidebar izquierdo fijo: `260 px` de ancho, fondo Navy.
- Topbar fijo: `64 px` de alto.
- Área de contenido principal: `margin-left: 260 px`, `min-height: calc(100vh − 64px)`.
- Radio de borde base de las tarjetas: `8 px` (`rounded-xl`). Sombra de tarjeta: `shadow-card`.

---

## Arquitectura

### Estructura de módulos

```
AppModule
├─ BrowserModule + HttpClientModule + AppRoutingModule
└─ SharedModule  ──────────────────────────────────────────────────────────┐
   declara: LayoutComponent, SidebarComponent, TopbarComponent,
            OptimizationToastComponent, VesselAlertToastComponent, TranslatePipe
                                                                            │
   ┌───────────────── módulos de funcionalidad con lazy-loading ────────────┘
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

Todas las rutas de funcionalidad son **lazy-loaded** (`loadChildren` con `import()` dinámico). La ruta por defecto redirige a `/dashboard`.

### Gestión de estado reactivo

Stores singleton (simples `BehaviorSubject` de RxJS) comparten estado entre páginas sin necesidad de NgRx:

| Servicio | Tipo | Propósito |
|---|---|---|
| `TransformationStoreService` | `BehaviorSubject<TransformApiResponse \| null>` | Último resultado de transformación de datos correcto |
| `OptimizationParamsStoreService` | `BehaviorSubject<OptimizationParams \| null>` | Configuración de pilotos / remolcadores / zonas de amarre introducida por el usuario |
| `OptimizationResultStoreService` | `BehaviorSubject<OptimizationApiResult \| null>` | Último resultado de ejecución del optimizador (compartido por Optimization, Statistics, VesselAlertService) |

Todos los servicios usan `@Injectable({ providedIn: 'root' })`.

---

## Páginas

### 1. Dashboard (`/dashboard`)

Vista operativa en tiempo real. Compuesta por cuatro subcomponentes.

#### Tarjetas KPI (`MetricCardComponent`)

Lee `TransformationStoreService` y muestra cuatro métricas:

| Métrica | Fuente |
|---|---|
| Total Vessels (buques totales) | `data.length` de la última transformación |
| Active Berths (muelles activos) | recuento de valores únicos de `berth_id` |
| Avg. Duration (duración media) | media de `duration_hours` en todas las escalas |
| Skipped Rows (filas omitidas) | `transformation_summary.skipped_rows` |

Todas las métricas muestran `—` cuando no hay ningún dataset cargado.

#### Berth Allocation Timeline (`BerthTimelineComponent`)

Diagrama de Gantt de swim-lanes a 24 horas que se suscribe **tanto** a `TransformationStoreService` (datos históricos) como a `OptimizationResultStoreService` (resultados del optimizador), cambiando de modo automáticamente.

**Cambio de modo:**

| Modo | Disparador | Fuente de datos | Renderizado de buques |
|---|---|---|---|
| Histórico | Transformación cargada, sin resultado de optimizador | `TransformationStoreService` | Bloque de color sólido por hash de `call_id` |
| Optimizador | Tras ejecutar el optimizador (`isOptimizerMode = true`) | `OptimizationResultStoreService` | Segmentos coloreados por fase (atraque / ejecución / desatraque) |

- **Navegación por días**: recopila todos los días del calendario abarcados por cualquier buque; los muestra como una lista navegable. Por defecto muestra el día actual si el dataset lo contiene; si no, muestra el último o el primer día disponible.
- **Algoritmo de swim-lanes** (`assignLanes`): asignación por «carril libre más temprano»; `LANE_PX = 44 px` por carril.
- **Indicadores de recorte**: los buques cuya estancia cruza la medianoche reciben iconos de flecha direccional + adaptación de esquinas redondeadas.
- **Indicadores de aviso**: en modo optimizador, los buques cuyo `scheduled_end` ya ha pasado pero siguen listados muestran un icono ⚠ naranja (operación con sobretiempo); los buques cuya ETA está dentro de [−1 h, +3 h] respecto a ahora muestran un icono de ancla ámbar (aproximándose/llegado).
- **Línea de «ahora»**: línea vertical verde que se actualiza cada 60 segundos. Solo se muestra cuando el día seleccionado es hoy.

#### Terminal Map (`TerminalMapComponent`)

Mapa satelital interactivo (Leaflet + Esri World Imagery + etiquetas de CartoDB) que muestra posiciones AIS de buques en vivo. Los marcadores se colorean según el estado de navegación, rotan según el `TrueHeading` y se purgan automáticamente tras 10 minutos sin actualización de posición.

#### Action Alerts (`ActionAlertsComponent`)

Panel estático de interfaz que muestra alertas operativas priorizadas. Contenido de marcador de posición (placeholder).

---

### 2. Data Input (`/data-input`)

Formulario de una sola página para subir datos portuarios en bruto y configurar los parámetros del optimizador.

- Subida por arrastrar-y-soltar o selector de archivo (`.csv` / `.xlsx`, máx. 50 MB) → POST multipart a `/api/v1/transform/`.
- Tabla de vista previa transformada (primeras 10 filas válidas).
- Tarjeta de Resumen de Transformación: filas totales, registros válidos, filas omitidas, motivos de omisión.
- Panel de Parámetros de Optimización: nº de pilotos, nº de remolcadores, definiciones de zona de amarre por muelle (continuo con `noray_max` / discreto con `capacity`).
- Buscador en vivo de muelles, persistencia de configuración en localStorage, importación/exportación de configuración en JSON.

---

### 3. Statistics (`/statistics`)

Análisis estadístico en profundidad, en dos pestañas independientes.

#### Selector de pestañas

Un control segmentado cambia entre **CSV** (datos históricos transformados) y **Optimizer** (última ejecución del optimizador). El selector solo se muestra una vez hay un resultado de optimizador disponible.

#### Pestaña CSV

| Gráfico | Descripción |
|---|---|
| **Tarjetas KPI** | Buques totales · Muelles únicos · Estancia media (`hh:mm`) · Rango de fechas |
| **Duración media + Volumen de carga por mes** | Gráfico de barras horizontales dobles en una ventana de 6 meses, con navegación anterior/siguiente |
| **Panel de detalle mensual** | Ocupación por muelle · desglose por tipo de operación · desglose por grupo de mercancía |
| **Distribución de llegadas** | Gráfico de barras verticales con 24 franjas, de llegadas de buques por hora del día |

#### Pestaña Optimizer

Reproduce los tres primeros gráficos de la pestaña CSV y añade paneles específicos del optimizador:

| Gráfico | Descripción |
|---|---|
| **Tarjetas KPI** | Buques asignados · Estancia media total (todas las fases) · Mejora vs. greedy % |
| **Distribución de atraques y desatraques** | Gráfico de 24 columnas con dos barras superpuestas por hora (azul cielo = inicios de atraque, violeta = inicios de desatraque). Tooltip personalizado al pasar el ratón; el pie muestra la hora pico de cada fase. |
| **Fases de la operación** | Barras horizontales para fondeo / atraque / ejecución / desatraque, con horas totales y medias |
| **Fondeo por muelle** | Horas totales y medias de fondeo por muelle, ordenadas de mayor a menor total |
| **Distribución de tiempos de espera** | Gráfico de barras verticales con 5 franjas (0 h / 0–10 h / 10–20 h / 20–30 h / >30 h) |
| **Fuentes de duración** | Barras horizontales por método de estimación (`provided` / `rate_model` / `statistical_model` / `default`) |
| **Asignación de recursos por mes** | Dotación de pilotos y remolcadores basada en FTE, en una ventana de 6 meses. **Fórmula de FTE**: `ceil( Σ [ceil(horas_atraque) + ceil(horas_desatraque)] / horas_disponibles )`, donde `horas_disponibles = 48 × (días_del_mes / 7)`. Chips de pico anual muestran la plantilla del mes más ocupado. También se muestran el pico de uso simultáneo y las horas de espera provocadas por falta de recursos (`pilot_wait_h`, `tug_wait_h`). |

---

### 4. Optimization (`/optimization`)

Página de doble modo con un Gantt multi-ventana de 5 días y capacidades completas de re-planificación dinámica.

#### Cambio de modo

| Modo | Disparador | Fuente de datos |
|---|---|---|
| Histórico | Datos transformados cargados, sin resultado de optimizador | `TransformationStoreService` |
| Optimizador | Tras una llamada correcta a `runOptimization()` | `OptimizationResultStoreService` |

`resetOptimizer()` (botón *Re-run*) limpia el store de resultados y vuelve al modo Histórico.

#### Tarjetas KPI

**Modo histórico:** Buques · Muelles · Duración media · Omitidos.

**Modo optimizador:**

| Tarjeta | Valor | Condición favorable |
|---|---|---|
| Fondeo total | suma de `fondeo.duration_h` de todos los buques asignados | < 1 h |
| Fondeo medio | media de `fondeo.duration_h` por buque asignado | < 1 h |
| Mejora vs. greedy | `improvement_vs_greedy_pct` % | ≥ 0 % |
| Buques sin resolver | recuento de `unresolved_vessels` | = 0 |

Paneles adicionales del optimizador: barras de utilización de muelle, píldoras de desglose de fuente de duración, contador de conflictos resueltos, contadores de retraso por recurso (`pilot_caused` / `tug_caused`).

#### Gantt — multi-ventana (5 días)

El Gantt muestra **5 días por ventana**; la navegación avanza o retrocede 5 días de una vez. El eje temporal muestra etiquetas de día en lugar de horas.

- **Sistema de swim-lanes**: algoritmo `assignLanes()`, `LANE_PX = 44 px`, soporta buques concurrentes dentro del mismo muelle.
- **Indicadores de recorte**: iconos de flecha + adaptación de esquinas redondeadas para buques que empiezan antes o terminan después de la ventana.
- **Renderizado de segmentos por fase** (modo optimizador):
  - `fondeo` — burbuja ámbar semitransparente con icono ⚓ y duración
  - `atraque` — segmento azul cielo
  - `ejecucion` — segmento verde esmeralda
  - `desatraque` — segmento índigo
  - `delay` — segmento rojo (marcador visual de retraso de llegada u operación)
  - `waiting_undock` — segmento lila (buque esperando en el muelle recursos para desatracar)
  - `early_arrival` — segmento cian (el buque llegó antes de su ETA)
- **Iconos de aviso**: ⚠ naranja en buques cuyo `scheduled_end` ya ha pasado (sobretiempo de operación); ⚓ ámbar en buques dentro de [ETA − 1 h, ETA + 3 h] (aproximándose/llegado).
- **Manejador de clic**: abre `VesselDetailPanelComponent`.

#### Re-planificación dinámica

Aplica un retraso a un buque y llama a `POST /api/v1/optimize/replan`.

Se admiten tres tipos de retraso:

| Tipo | Efecto |
|---|---|
| `arrival` | El buque se retrasa en mar; la ETA se pospone. Si el margen de fondeo absorbe el retraso, no se re-optimiza ningún muelle. |
| `operation` | La operación de carga se está alargando; se amplía `estimated_duration_h`. Se dispara una re-planificación en cascada si desplaza a los buques siguientes. |
| `early_arrival` | El buque llegó antes de su ETA; el optimizador intenta atracarlo antes. |

Los retrasos acumulados se guardan por buque y se envían como totales en cada llamada a `/replan`. Tras cada re-planificación correcta, se actualiza la instantánea base de asignaciones para que las siguientes llamadas se compongan sobre el último horario. Un flag `replan_triggered` en la respuesta indica si se ejecutó una re-optimización parcial completa o si el margen de fondeo fue suficiente.

#### Completado anticipado de la operación de carga

Llama a `POST /api/v1/optimize/early_complete` cuando un buque termina su operación antes de la hora de fin programada.

- Trunca la fase `ejecucion` en el momento de finalización confirmado.
- Comprueba la disponibilidad de pilotos y remolcadores para el desatraque inmediato; inserta una fase `waiting_undock` (lila) si los recursos están ocupados.
- Encadena un adelanto (pull-forward) para cualquier buque que esté esperando en fondeo ese mismo muelle.
- Devuelve `waiting_undock_h` y `berth_freed_delta_h` para mostrarlos en el panel de detalle.

#### Panel de detalle del buque (`VesselDetailPanelComponent`)

Panel deslizante (500 px de ancho, fijo a la derecha, `z-50`) que se abre al hacer clic en un bloque del Gantt.

Muestra los metadatos del buque, el muelle asignado, la lista de mercancía y — en modo optimizador — el desglose completo de fases con una barra de color proporcional a cada fase. Los botones de acción del pie avanzan el estado operativo: `en camino → en curso → completado`, además de un botón **Delay** que abre el formulario de retraso y un botón **Early Complete**.

---

## Servicios principales

### `PortOptimApiService`

| Método | HTTP | Endpoint | Descripción |
|---|---|---|---|
| `transformFile(file)` | `POST` | `/api/v1/transform/` | Subida multipart → `TransformApiResponse` |
| `runOptimization(req)` | `POST` | `/api/v1/optimize/run` | Ejecuta el optimizador → `OptimizationApiResult` |
| `replan(req)` | `POST` | `/api/v1/optimize/replan` | Re-planifica tras retrasos → `ReplanResponse` |
| `earlyComplete(req)` | `POST` | `/api/v1/optimize/early_complete` | Completado anticipado → `EarlyCompleteResponse` |

URL base: `http://localhost:8000`.

### `OptimizationRunnerService`

Gestiona el ciclo de vida de la API del optimizador para que sobreviva a la navegación entre componentes de Angular. Métodos principales:

| Método | Descripción |
|---|---|
| `run()` | Llama a `/run`, actualiza el store de resultados, muestra notificación toast |
| `applyDelay(vesselId, delayH, type)` | Acumula el retraso y llama a `/replan` |
| `confirmEarlyComplete(vesselId, completeTime)` | Llama a `/early_complete` y actualiza la instantánea base |
| `resetDelays()` | Limpia los retrasos acumulados al reiniciar el optimizador |

Expone los streams `isRunning$`, `isReplanning$`, `showNotification$`, `showReplanNotification$`.

### `VesselAlertService`

Singleton que vigila el resultado de optimización y calcula alertas de buques basadas en tiempo. Se actualiza cada 60 segundos y cada vez que se carga un nuevo resultado.

| Tipo de alerta | Ventana activa | Disparador |
|---|---|---|
| `arrival` (llegada) | `[ETA − 1 h, ETA + 3 h]` | El buque se aproxima o ha llegado recientemente |
| `departure` (salida) | `[scheduled_end, scheduled_end + 5 h]` | La operación debería haber terminado pero el buque sigue en el muelle |

Las alertas nuevas se emiten una única vez a través de `newAlert$` para que `VesselAlertToastComponent` pueda mostrarlas. Expone `alerts$`, `unreadCount$`, `hasUnread$`, `markAllRead()`, `dismiss(id)`.

### `AisStreamService`

Cliente WebSocket para el relay AIS en `ws://localhost:8000/ws/ais-stream`. Se reconecta automáticamente con backoff exponencial (máx. 30 s). Envía mensajes `bbox` para filtrar el área.

### Servicios de store

| Servicio | Tipo almacenado | Usado por |
|---|---|---|
| `TransformationStoreService` | `TransformApiResponse \| null` | Dashboard, DataInput, Optimization, Statistics |
| `OptimizationParamsStoreService` | `OptimizationParams \| null` | DataInput, Optimization |
| `OptimizationResultStoreService` | `OptimizationApiResult \| null` | Dashboard, Optimization, Statistics, VesselAlertService |

---

## Componentes compartidos

### `TopbarComponent`

Barra superior con:
- Nombre de la ruta activa.
- Selector de idioma (desplegable, 4 idiomas).
- Badge de alertas no leídas (número sobre icono de campana).
- Panel de notificaciones desplegable con lista de alertas activas, opción de marcar todas como leídas y descarte individual.

### `VesselAlertToastComponent`

Pila de toasts apilados verticalmente (los nuevos abajo). Cada toast:
- Muestra el tipo de alerta (llegada / salida), el ID del buque y la ventana de expiración.
- Se auto-descarta a los 6 s con una barra de progreso animada.
- Tiene un botón de cierre manual con animación de deslizamiento de salida.
- Las alertas simultáneas son todas visibles a la vez (una entrada por alerta).

### `OptimizationToastComponent`

Toast flotante que aparece cuando una optimización o re-planificación finaliza estando fuera de la página `/optimization`.

### `LayoutComponent`

Shell principal: sidebar fijo + topbar + `<router-outlet>` + `<app-vessel-alert-toast>` + `<app-optimization-toast>`.

---

## Modelos de la API (`core/models/api.models.ts`)

### Salida de la optimización (actualizado)

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
  pilot_wait_h: number;          // horas de fondeo atribuibles a la falta de pilotos
  tug_wait_h: number;            // horas de fondeo atribuibles a la falta de remolcadores
  caused_delay_to: string[];
  delay_h?: number;              // retraso total aplicado (desde /replan); genera el segmento rojo
  early_arrival_h?: number;      // horas de llegada anticipada (desde /replan early_arrival)
  phases: OperationPhase[];
}

// Los nombres de fase incluyen las estándar + las de re-planificación dinámica:
type PhaseName =
  | 'fondeo' | 'atraque' | 'ejecucion' | 'desatraque'  // estándar
  | 'delay'                                              // retraso de llegada u operación (rojo)
  | 'waiting_undock'                                     // esperando en el muelle recursos para desatracar (lila)
  | 'early_arrival';                                     // llegó antes de su ETA (cian)
```

### Modelos de re-planificación

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

### Modelos de completado anticipado

```typescript
interface EarlyCompleteRequest {
  vessel_id: string;
  complete_time: string;          // hora local en formato ISO 8601 (sin 'Z')
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

## Internacionalización

Sistema propio del lado del cliente — sin el builder de i18n de Angular. `translations.ts` exporta ~210 claves por idioma (~840 traducciones en total), incluyendo claves nuevas para: `notif.*` (tipos y motivos de alerta), `opt.phase.*` (nombres de fase dinámicos), `stats.*` (gráficos de la página de Estadísticas).

| Idioma | Código |
|---|---|
| Inglés | `en` |
| Español | `es` |
| Alemán | `de` |
| Francés | `fr` |

`TranslatePipe` (`pure: false`) llama a `LanguageService.t(key)` en cada ciclo de detección de cambios, para actualizar la interfaz al instante cuando se cambia de idioma.

---

## Estructura del proyecto

```
portoptim/src/app/
├── app.component.ts/html          Componente raíz
├── app-routing.module.ts          Rutas con lazy-load
├── app.module.ts
│
├── core/
│   ├── i18n/
│   │   └── translations.ts        ~840 cadenas de traducción (en/es/de/fr)
│   ├── models/
│   │   └── api.models.ts          BerthCall, OptimizationAssignment, OperationPhase,
│   │                              ReplanRequest/Response, EarlyCompleteRequest/Response,
│   │                              VesselDelay, VesselAlert (vía VesselAlertService)
│   └── services/
│       ├── language.service.ts
│       ├── portoptim-api.service.ts        Cliente HTTP (transform + optimize + replan + early_complete)
│       ├── optimization-runner.service.ts  Ciclo de vida: run / applyDelay / confirmEarlyComplete / reset
│       ├── optimization-result-store.service.ts
│       ├── optimization-params-store.service.ts
│       ├── transformation-store.service.ts
│       └── vessel-alert.service.ts         Alertas de llegada/salida basadas en tiempo (refresco 60 s)
│
├── shared/
│   ├── components/
│   │   ├── layout/                Shell (sidebar + topbar + outlet + toasts)
│   │   ├── topbar/                Badge de alertas, panel de alertas, selector de idioma
│   │   ├── sidebar/                Enlaces de navegación
│   │   ├── optimization-toast/    Toast para finalización de optimización / replan
│   │   └── vessel-alert-toast/    Pila de toasts de llegada/salida de buques (auto-cierre 6 s)
│   ├── pipes/
│   │   └── translate.pipe.ts
│   └── shared.module.ts
│
└── features/
    ├── dashboard/
    │   ├── components/
    │   │   ├── berth-timeline/    Gantt de 24 h con iconos de aviso de llegada y sobretiempo
    │   │   ├── metric-card/
    │   │   ├── action-alerts/
    │   │   └── terminal-map/
    │   └── dashboard.component.ts/html
    ├── data-input/
    │   └── data-input.component.ts/html
    ├── statistics/
    │   └── statistics.component.ts/html   Pestaña CSV + pestaña Optimizer (fases, recursos, FTE)
    └── optimization/
        ├── optimization.component.ts/html  Gantt de 5 días + re-planificación + completado anticipado + KPIs
        └── components/
            └── vessel-detail-panel/        Panel deslizante con fases, formulario de retraso, completado anticipado
```

---

## Integraciones externas

| Servicio | Protocolo | Propósito |
|---|---|---|
| Backend de PortOptim | HTTP REST | Transformación de datos, optimización de horarios, re-planificación, completado anticipado |
| Backend de PortOptim | WebSocket | Relay de posiciones AIS (`/ws/ais-stream`) |
| Esri ArcGIS | HTTPS (tile) | Mapa base satelital |
| CartoDB | HTTPS (tile) | Capa de etiquetas de nombres de lugar |
| Nominatim (OSM) | HTTPS (JSON) | Geocodificación de puertos/lugares para el buscador del mapa |

---

## Instalación y puesta en marcha

### Requisitos previos

- Node.js ≥ 18
- Angular CLI ≥ 19

```bash
npm install -g @angular/cli
```

### Desarrollo

```bash
cd portoptim
npm install
ng serve
```

Abre `http://localhost:4200/`. El backend debe estar en ejecución en `http://localhost:8000`.

### Build de producción

```bash
ng build
```

Los artefactos compilados se escriben en `dist/`.

---

## Relacionado

- **portoptim-backend** — API en Python con FastAPI que da soporte al transformador de datos, el motor de optimización, la re-planificación, el completado anticipado y el relay WebSocket de AIS ([ver README del backend](../portoptim-backend/README.md))

---

## Autor

**Aythami Pérez Vega**
Grado en Ingeniería Informática · Universidad de Las Palmas de Gran Canaria
Tutores: **Nelson Monzón** · **Christopher Expósito Izquierdo**
