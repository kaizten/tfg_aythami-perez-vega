# PortOptim

**Sistema de optimización de atraques portuarios** — Proyecto de Fin de Grado en Ingeniería Informática, Universidad de Las Palmas de Gran Canaria.

PortOptim es una plataforma web full-stack que transforma datos históricos de escalas portuarias en programaciones de atraques optimizadas, con soporte de re-planificación dinámica ante imprevistos y seguimiento en tiempo real de embarcaciones mediante AIS.

---

## Descripción general

Los puertos gestionan diariamente la asignación de muelles a embarcaciones que compiten por recursos escasos: norays, prácticos, remolcadores y tiempo. PortOptim automatiza este proceso mediante un motor de optimización en tres fases (calibración estadística → planificación greedy → búsqueda local resource-aware) que minimiza el tiempo de espera total en fondeo, y gestiona el ciclo de vida operacional completo de cada escala: demoras en llegada, extensión de operaciones y completado anticipado.

El sistema se ha validado con datos reales correspondientes al periodo **2022–2025** (~13 000 escalas).

---

## Repositorios

| Repositorio | Descripción |
|---|---|
| [`portoptim`](./portoptim/) | Frontend Angular 19 — interfaz de operaciones |
| [`portoptim-backend`](./portoptim-backend/) | Backend FastAPI — transformador de datos, motor de optimización, re-planificación dinámica y relay AIS |

---

## Arquitectura del sistema

```
┌──────────────────────────────────────────────────────────────────────┐
│                            Browser                                   │
│                                                                      │
│   Angular 19  ──HTTP──►  FastAPI  ──►  Optimizer engine              │
│   (Dashboard,            (uvicorn)      (calibración → greedy → LS)  │
│    Data Input,                    ──►  Data transformer              │
│    Optimization,                  ──►  Conflict detector             │
│    Statistics)  ◄──WebSocket──  AIS relay ◄── aisstream.io           │
└──────────────────────────────────────────────────────────────────────┘
```

El backend actúa como proxy WebSocket entre [aisstream.io](https://aisstream.io/) y los clientes Angular, de modo que un único slot de API key sirve a todos los usuarios conectados simultáneamente.

---

## Funcionalidades principales

### Transformación de datos
- Ingesta de ficheros CSV/Excel exportados de sistemas portuarios españoles.
- Pipeline de seis etapas: validación de esquema → renombrado → limpieza → normalización → fusión de operaciones concurrentes → modelos Pydantic.
- Soporte para formatos de fecha inconsistentes, valores nulos y operaciones simultáneas en el mismo atraque.

### Motor de optimización (3 fases)
- **Fase 1 — Calibración** (opcional): aprende modelos estadísticos de duración (tasa t/h, duración mediana por tipo de operación/mercancía/eslora, maniobras) a partir de datos históricos.
- **Fase 2 — Greedy**: asigna muelles por GT descendente con restricciones reales de prácticos y remolcadores. Soporta berths continuos (rango de norays) y discretos (slots de capacidad). Procesa las escalas día a día; los estados de muelle se propagan entre días.
- **Fase 3 — Búsqueda local resource-aware**: intercambio intra-muelle (hasta 500 iteraciones) evaluando el coste total de berth + recursos mediante **background pools** — pools de pilotos/remolcadores pre-cargados con los compromisos de los demás muelles — para evitar reordenaciones que ahorren tiempo de berth pero generen conflictos de recursos cruzados.

### Re-planificación dinámica
- **Retraso de llegada** (`arrival`): el optimizador extiende la fase de fondeo; si el buffer no es suficiente, re-optimiza solo los muelles afectados sin tocar el resto.
- **Retraso de operación** (`operation`): extiende la duración estimada; desencadena re-planificación parcial si desplaza barcos siguientes.
- **Llegada anticipada** (`early_arrival`): el optimizador intenta adelantar el atraque si el muelle está libre antes de la ETA original.
- **Detección de conflictos** (`conflict.py`): comprueba solapamientos de berth, excesos de pilotos y excesos de remolcadores en la ventana de maniobra.

### Completado anticipado de operaciones
- El operador confirma que un buque terminó su carga/descarga antes de la hora programada.
- El sistema calcula el slot de desatraque más temprano posible respetando la disponibilidad de prácticos y remolcadores, inserta una fase `waiting_undock` (lila) si los recursos no están disponibles, y desplaza hacia adelante la cola de espera del muelle liberado.

### Dashboard operacional
- Gantt de 24 h con swim-lanes por muelle, navegación por día y línea «ahora».
- Indicadores de alerta: ⚠ naranja en operaciones con retraso; ⚓ ámbar en buques en ventana de llegada.
- Mapa satelital interactivo (Leaflet + Esri) con marcadores AIS en tiempo real coloreados por estado de navegación.
- KPIs: buques totales, muelles activos, duración media, filas omitidas.

### Vista de optimización
- Gantt multi-ventana de **5 días** con navegación por ventana y swim-lanes concurrentes.
- Visualización de fases por colores: fondeo (ámbar) · atraque (sky) · ejecución (verde) · desatraque (índigo) · `delay` (rojo) · `waiting_undock` (lila) · `early_arrival` (cyan).
- Panel de re-planificación: aplicar demoras o completado anticipado desde el panel lateral de detalle de escala.
- KPIs comparativos: tiempo total en fondeo, mejora vs. greedy, buques sin resolver, utilización por muelle, retardos por práctico/remolcador.

### Página de Estadísticas
- **Pestaña CSV**: análisis del dataset histórico transformado — ocupación por muelle, evolución mensual, distribución por tipo de operación y mercancía, distribución horaria de llegadas.
- **Pestaña Optimizer**: análisis del resultado de la última optimización — distribución de tiempos de fondeo, análisis de fases (duración media por fase), fondeo por muelle, distribución de fuentes de estimación, **análisis de recursos**: horas de espera por práctico/remolcador, pico simultáneo observado, estimación de FTE mensual.
- Gráfico de atraques/desatraques por hora con barras superpuestas y tooltip interactivo.

### Sistema de alertas de buques
- `VesselAlertService` calcula alertas de llegada (`[ETA − 1 h, ETA + 3 h]`) y de salida (`[scheduled_end, scheduled_end + 5 h]`) con refresco cada 60 s.
- Toasts apilados con auto-dismiss de 6 s y barra de progreso animada.
- Panel de notificaciones en el topbar con badge de no leídas.

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Frontend | Angular 19, TypeScript 5.7, Tailwind CSS 3.4, RxJS 7.8, Leaflet 1.9 |
| Backend | Python, FastAPI, Pydantic v2, pandas |
| Servidor | uvicorn |
| Tiempo real | WebSocket (AIS relay via aisstream.io) |
| Geocodificación | Nominatim (OpenStreetMap) |
| Mapas | Esri World Imagery + CartoDB labels |
| Testing | pytest (85 tests) · Karma + Jasmine |

---

## Requisitos previos

- **Node.js** ≥ 18 y Angular CLI ≥ 19
- **Python** ≥ 3.10
- Clave API de [aisstream.io](https://aisstream.io/) (para el mapa en tiempo real)

---

## Instalación y arranque

### Backend

```bash
cd portoptim-backend

# Crear y activar entorno virtual
python -m venv .venv
source .venv/bin/activate          # macOS / Linux
# .venv\Scripts\activate           # Windows

# Instalar dependencias
pip install -r requirements.txt

# Configurar variables de entorno
cp .env.example .env
# → editar .env y añadir la clave AIS_API_KEY

# Arrancar el servidor de desarrollo
uvicorn main:app --reload
```

La API estará disponible en `http://localhost:8000`.  
Documentación interactiva: `http://localhost:8000/docs`.

### Frontend

```bash
cd portoptim

npm install
ng serve
```

La aplicación estará disponible en `http://localhost:4200`.

> El backend debe estar en ejecución en `http://localhost:8000` para que las llamadas a la API y el relay AIS funcionen correctamente.

---

## Guía de usuario

Esta guía describe el flujo de uso habitual de la aplicación, página por página, tal como la vería un operador portuario.

### Flujo general

```
1. Data Input     → subir CSV/Excel + configurar recursos (pilotos, remolcadores, muelles)
2. Optimización   → ejecutar el motor de optimización y revisar el Gantt de 5 días
3. Dashboard      → seguimiento operativo diario (Gantt 24 h + mapa AIS en tiempo real)
4. Estadísticas   → análisis histórico y del resultado del optimizador
```

El estado se comparte automáticamente entre páginas (mediante los *stores* de la app), así que no hace falta repetir la carga de datos al navegar de una sección a otra.

### 1. Carga de datos y configuración (`/data-input`)

Es el punto de partida obligatorio: sin datos transformados, el resto de páginas no tienen contenido que mostrar.

1. **Subir el fichero**: arrastra un `.csv` o `.xlsx` sobre la zona de carga, o selecciónalo con el explorador de archivos (tamaño máximo 50 MB).
2. **Revisar la vista previa**: la app muestra las 10 primeras filas ya transformadas, junto con una tarjeta de *Resumen de transformación* (filas totales, registros válidos, filas omitidas y motivos de omisión).
3. **Configurar los recursos del optimizador**, en el panel *Optimization Parameters*:
   - Número de **pilotos** y **remolcadores** disponibles.
   - Definición de cada **muelle**: continuo (con `noray_max`) o discreto (con `capacity` en slots).
   - Puedes filtrar la lista de muelles con el buscador en vivo.
4. **Guardar la configuración**: se persiste automáticamente en el navegador (localStorage). También puedes **exportar** la configuración a un fichero JSON para reutilizarla, o **importar** una configuración previamente guardada.

> 💡 Si vuelves a esta página más adelante, tu configuración de pilotos/remolcadores/muelles seguirá ahí.

### 2. Ejecutar la optimización (`/optimization`)

Aquí se lanza el motor de optimización de 3 fases y se gestiona la operativa día a día.

1. Pulsa **Ejecutar optimización** para lanzar el proceso (calibración opcional → greedy → búsqueda local). Al finalizar, la página cambia automáticamente de modo *Histórico* a modo *Optimizador*.
2. **Lee las tarjetas KPI**: fondeo total, fondeo medio, mejora vs. greedy (%) y buques sin resolver. Los colores indican si el valor es favorable o no.
3. **Navega el Gantt de 5 días**: usa las flechas para moverte de ventana en ventana (5 días a la vez). Cada fila es un muelle; cada barra, una escala.
4. **Interpreta los colores de las fases**:

   | Color | Fase | Significado |
   |---|---|---|
   | Ámbar (burbuja ⚓) | `fondeo` | Buque esperando fondeado |
   | Azul cielo | `atraque` | Maniobra de atraque |
   | Verde | `ejecucion` | Carga/descarga en curso |
   | Índigo | `desatraque` | Maniobra de desatraque |
   | Rojo | `delay` | Retraso aplicado (llegada u operación) |
   | Lila | `waiting_undock` | Esperando recursos para desatracar |
   | Cian | `early_arrival` | El buque llegó antes de lo previsto |

5. **Iconos de aviso** sobre las barras: ⚠ naranja = la operación ha superado su hora prevista de fin; ⚓ ámbar = el buque está en ventana de llegada (entre 1 h antes y 3 h después de su ETA).
6. **Panel de detalle de un buque**: haz clic sobre cualquier barra del Gantt para abrir el panel lateral con la ficha completa (muelle asignado, mercancía, desglose de fases). Desde ahí puedes:
   - Avanzar el estado operativo: *en camino → en curso → completado*.
   - Pulsar **Delay** para registrar un retraso de llegada o de operación (el sistema re-planifica solo lo necesario).
   - Pulsar **Early Complete** para confirmar que la carga/descarga terminó antes de lo previsto; el sistema calcula el desatraque más temprano posible y adelanta la cola de espera de ese muelle si procede.
7. **Re-ejecutar**: el botón *Re-run* limpia el resultado actual y vuelve al modo histórico, por si quieres lanzar la optimización de nuevo con otros parámetros.

### 3. Seguimiento diario (`/dashboard`)

Vista operativa del día a día, pensada para consulta rápida.

- **Tarjetas KPI**: buques totales, muelles activos, duración media y filas omitidas.
- **Gantt de 24 horas**: igual que el de optimización pero centrado en un solo día, con navegación por días y una línea verde vertical que marca la hora actual («ahora»). Cambia automáticamente entre datos históricos y datos del optimizador, según cuál esté disponible.
- **Mapa del puerto**: mapa satelital interactivo con las posiciones AIS de los buques en tiempo real (requiere que el backend tenga configurada una clave de aisstream.io). Los marcadores rotan según el rumbo del buque y se colorean según su estado de navegación.
- **Alertas de acción**: panel con los avisos operativos más relevantes del momento.

### 4. Estadísticas (`/statistics`)

Análisis en profundidad, organizado en dos pestañas (la pestaña *Optimizer* solo aparece una vez que has ejecutado una optimización):

- **Pestaña CSV** — analiza el dataset histórico: ocupación por muelle, evolución mensual de duración y volumen de carga (navegable por ventanas de 6 meses), desglose por tipo de operación/mercancía y distribución horaria de llegadas.
- **Pestaña Optimizer** — analiza el resultado de la última optimización: tiempos de fondeo, duración media por fase, fondeo por muelle, distribución de atraques/desatraques por hora, y un panel de **recursos** con horas de espera por pilotos/remolcadores, picos de uso simultáneo y una estimación de personal necesario (FTE) mes a mes.

### Alertas de buques

El sistema vigila automáticamente (refresco cada 60 s) los buques a punto de llegar o que deberían haber zarpado ya:

- Aparece un **toast** emergente por cada alerta nueva, con auto-cierre a los 6 segundos (o cierre manual).
- El icono de campana en la barra superior muestra un contador de alertas no leídas; al abrir el panel puedes revisar el histórico y marcarlas todas como leídas.
- Si una optimización o re-planificación termina mientras estás en otra página, un toast flotante te avisa igualmente.

### Otros ajustes de la interfaz

- **Idioma**: selector desplegable en la barra superior (español, inglés, alemán, francés).
- La barra lateral izquierda da acceso directo a las cuatro páginas principales en cualquier momento.

---

## API — Endpoints principales

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/api/v1/transform/` | Subir CSV/Excel → `BerthCall[]` transformados |
| `POST` | `/api/v1/optimize/run` | Ejecutar optimización → assignments + KPIs |
| `POST` | `/api/v1/optimize/replan` | Re-planificar tras retrasos → schedule actualizado |
| `POST` | `/api/v1/optimize/early_complete` | Completado anticipado → cascada pull-forward |
| `GET` | `/api/v1/optimize/calibration-stats` | Estadísticas del modelo de calibración |
| `POST` | `/api/v1/optimize/calibrate` | Cargar CSV histórico y ajustar modelos |
| `WebSocket` | `/ws/ais-stream` | Relay AIS en tiempo real |

---

## Estructura del monorepo

```
portoptim-root/
├── portoptim/                  Frontend Angular
│   ├── src/app/
│   │   ├── core/               Servicios (runner, stores, VesselAlertService), modelos, i18n (en/es/de/fr)
│   │   ├── shared/             Layout, Sidebar, Topbar (con alertas), OptimizationToast, VesselAlertToast
│   │   └── features/
│   │       ├── dashboard/      Gantt 24 h (con indicadores de alerta) + Mapa AIS + KPIs
│   │       ├── data-input/     Upload CSV/Excel + configuración del optimizador
│   │       ├── optimization/   Gantt 5-días + re-planificación + completado anticipado + panel de detalle
│   │       └── statistics/     Estadísticas CSV + Estadísticas del optimizador (fases, recursos, FTE)
│   ├── tailwind.config.js
│   └── README.md
│
├── portoptim-backend/          Backend FastAPI
│   ├── app/
│   │   ├── api/v1/routes/      Endpoints REST + WebSocket AIS
│   │   ├── models/             Modelos Pydantic (BerthCall, Vessel)
│   │   └── services/transformer/  Pipeline de transformación de datos
│   ├── optimizer/
│   │   ├── calibration.py      Fase 1: modelos estadísticos de duración y maniobra
│   │   ├── scheduler.py        Fase 2: greedy con ResourcePool interval-based
│   │   ├── local_search.py     Fase 3: búsqueda local con background resource pools
│   │   ├── conflict.py         Detección de conflictos para re-planificación
│   │   ├── optimizer.py        Orquestador: optimize() · replan() · early_complete()
│   │   └── router.py           FastAPI router (/run · /replan · /early_complete · /calibrate)
│   ├── tests/                  85 tests unitarios e integración
│   └── README.md
│
└── README.md                   ← Este fichero
```

---

## Datos

El sistema se ha desarrollado y validado con el fichero `Datos_Escala_2022_2025_vF.csv`, que contiene **~13 000 escalas reales** con los siguientes campos:

`Escala Estado` · `Muelle Real` · `Noray Inicio/Fin` · `Escala` · `Fecha Atraque/Desatraque Real` · `Buque` · `Buque GT` · `Buque Eslora` · `Consignatario` · `Estibador` · `Tipo Operación` · `Cantidad` · `Lugar Operación` · `País` · `Puerto Origen` · `Mercancía` · `Naturaleza Mercancía` · `Grupo Mercancía`

El transformador de datos normaliza automáticamente este formato hacia el modelo interno `BerthCall` usado por el optimizador.

---

## Tests

```bash
# Backend
cd portoptim-backend
pytest -v
```

| Módulo | Tests | Área cubierta |
|---|---|---|
| `test_validator` | 8 | Validación de esquema |
| `test_cleaner` | 7 | Limpieza y deduplicación |
| `test_normalizer` | 20 | Fechas, tipos, vocabulario |
| `test_duration` | 6 | Estimación de duración (3 capas) |
| `test_scheduler` | 7 | Prioridad GT, norays, contención de recursos |
| `test_resources` | 15 | `required_tugs`, `ResourcePool` |
| `test_local_search` | 3 | Restricción GT, no-empeoramiento |
| `test_optimizer` | 8 | End-to-end, 20 muelles, KPIs |
| `test_maneuver_duration` | 5 | Modelo de maniobra |
| `test_phases` | 6 | Fases, timestamps consecutivos |

**Rendimiento**: 200 buques / 100 muelles → < 0,1 s (objetivo: < 2 s).

---

## Internacionalización

La interfaz está disponible en cuatro idiomas gestionados por un sistema i18n propio (sin el builder de Angular). El selector de idioma está en la barra superior.

| Idioma | Código |
|---|---|
| Español | `es` |
| English | `en` |
| Deutsch | `de` |
| Français | `fr` |

---

## Autor

**Aythami Pérez Vega**  
Grado en Ingeniería Informática · Universidad de Las Palmas de Gran Canaria  
Tutores: **Nelson Monzón López** · **Christopher Expósito Izquierdo**

---

## Licencia

Proyecto académico — TFG. Uso y distribución sujetos a los términos acordados con la Universidad de Las Palmas de Gran Canaria.
