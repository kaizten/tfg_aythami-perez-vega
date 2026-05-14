# PortOptim

**Sistema de optimización de atraques portuarios** — Proyecto de Fin de Grado en Ingeniería Informática, Universidad de Las Palmas de Gran Canaria.

PortOptim es una plataforma web full-stack que transforma datos históricos de escalas portuarias en programaciones de atraques optimizadas, integrando seguimiento en tiempo real de embarcaciones mediante AIS.

---

## Descripción general

Los puertos gestionan diariamente la asignación de muelles a embarcaciones que compiten por recursos escasos: norays, prácticos, remolcadores y tiempo. PortOptim automatiza este proceso mediante un motor de optimización en tres fases (calibración estadística → planificación greedy → búsqueda local) que minimiza el tiempo de espera total en fondeo.

El sistema se ha validado con datos reales correspondientes al periodo **2022–2025** (~13 000 escalas).

---

## Repositorios

| Repositorio | Descripción |
|---|---|
| [`portoptim`](./portoptim/) | Frontend Angular 19 — interfaz de operaciones |
| [`portoptim-backend`](./portoptim-backend/) | Backend FastAPI — transformador de datos, motor de optimización y relay AIS |

---

## Arquitectura del sistema

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│                                                             │
│   Angular 19  ──HTTP──►  FastAPI  ──►  Optimizer engine     │
│   (Dashboard,           (uvicorn)  ──►  Data transformer    │
│    Data Input,                                              │
│    Optimization)  ◄──WebSocket──  AIS relay ◄── aisstream.io│
└─────────────────────────────────────────────────────────────┘
```

El backend actúa como proxy WebSocket entre [aisstream.io](https://aisstream.io/) y los clientes Angular, de modo que un único slot de API key sirve a todos los usuarios conectados simultáneamente.

---

## Funcionalidades principales

### Transformación de datos
- Ingesta de ficheros CSV/Excel exportados de sistemas portuarios españoles.
- Pipeline de seis etapas: validación de esquema → renombrado → limpieza → normalización → fusión de operaciones concurrentes → modelos Pydantic.
- Soporte para formatos de fecha inconsistentes, valores nulos y operaciones simultáneas en el mismo atraque.

### Motor de optimización
- **Fase 1 — Calibración**: aprende modelos estadísticos de duración (tasa t/h, duración mediana, maniobras) a partir de datos históricos.
- **Fase 2 — Greedy**: asigna muelles por GT descendente con restricciones reales de prácticos y remolcadores; soporta berths continuos (rango de norays) y discretos (slots de capacidad).
- **Fase 3 — Búsqueda local**: intercambio intra-muelle con criterio de mejora estricta; < 0,1 s para 200 buques / 100 muelles.
- Estimación de duración en tres capas: duración proporcionada → modelo de tasa → modelo estadístico → valor por defecto.
- Desglose de fases por escala: fondeo · atraque · ejecución · desatraque.

### Dashboard operacional
- Gantt de 24 h con swim-lanes por muelle, navegación por día y línea «ahora».
- Mapa satelital interactivo (Leaflet + Esri) con marcadores AIS en tiempo real coloreados por estado de navegación.
- KPIs: buques totales, muelles activos, duración media, filas omitidas.

### Vista de optimización
- Alternancia automática entre modo histórico y modo optimizador.
- KPIs comparativos: tiempo total en fondeo, mejora vs. greedy, buques sin resolver, utilización por muelle.
- Panel lateral de detalle de escala con avance manual de estado operacional (en camino → en progreso → completado).

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

## Estructura del monorepo

```
portoptim-root/
├── portoptim/                  Frontend Angular
│   ├── src/app/
│   │   ├── core/               Servicios, modelos, i18n (en/es/de/fr)
│   │   ├── shared/             Layout, Sidebar, Topbar, TranslatePipe
│   │   └── features/
│   │       ├── dashboard/      Gantt + Mapa AIS + KPIs + Alertas
│   │       ├── data-input/     Upload CSV/Excel + configuración del optimizador
│   │       └── optimization/   Vista dual histórico/optimizador + panel de detalle
│   ├── tailwind.config.js
│   └── README.md
│
├── portoptim-backend/          Backend FastAPI
│   ├── app/
│   │   ├── api/v1/routes/      Endpoints REST + WebSocket AIS
│   │   ├── models/             Modelos Pydantic (BerthCall, Vessel)
│   │   └── services/transformer/  Pipeline de transformación de datos
│   ├── optimizer/              Motor de optimización (calibración, greedy, búsqueda local)
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

La interfaz está disponible en cuatro idiomas gestionados por un sistema i18n propio (sin el builder de Angular):

| Idioma | Código |
|---|---|
| Español | `es` |
| English | `en` |
| Deutsch | `de` |
| Français | `fr` |

El selector de idioma se encuentra en la barra superior de la aplicación.

---

## Autor

**Aythami Pérez Vega**  
Grado en Ingeniería Informática · Universidad de Las Palmas de Gran Canaria  
Tutores: **Nelson Monzón López** · **Christopher Expósito Izquierdo**

---

## Licencia

Proyecto académico — TFG. Uso y distribución sujetos a los términos acordados con la Universidad de Las Palmas de Gran Canaria.
