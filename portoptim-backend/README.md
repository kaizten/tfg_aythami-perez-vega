# portoptim-backend

API REST en Python para el sistema de planificación de atraques marítimos **PortOptim**, desarrollada como parte de un Trabajo de Fin de Grado (TFG) en Ingeniería Informática en la Universidad de Las Palmas de Gran Canaria.

---

## Módulos

| Módulo | Estado | Descripción |
|---|---|---|
| `data_transformer` | ✅ Implementado | Transforma datos heterogéneos de CSV portuarios españoles en registros `BerthCall` estandarizados |
| `optimizer` | ✅ Implementado | Algoritmo de planificación de atraques en tres fases: calibración → greedy → búsqueda local |
| `ais_relay` | ✅ Implementado | Relay WebSocket que conecta el feed en vivo de aisstream.io con los clientes del dashboard Angular |

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Framework | [FastAPI](https://fastapi.tiangolo.com/) |
| Validación | [Pydantic v2](https://docs.pydantic.dev/latest/) |
| Procesamiento de datos | [pandas](https://pandas.pydata.org/) |
| Gestión de configuración | [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) |
| Servidor | [uvicorn](https://www.uvicorn.org/) |
| Cliente WebSocket | [websockets](https://websockets.readthedocs.io/) |
| Logging | [structlog](https://www.structlog.org/) |
| Testing | [pytest](https://pytest.org/) + [httpx](https://www.python-httpx.org/) |

---

## Puesta en marcha rápida

```bash
# 1. Crear y activar el entorno virtual
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

# 2. Instalar dependencias
pip install -r requirements.txt

# 3. Configurar variables de entorno
cp .env.example .env

# 4. Arrancar el servidor de desarrollo
uvicorn main:app --reload
```

Documentación interactiva de la API disponible en **`http://localhost:8000/docs`**.

---

## Endpoints de la API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `POST` | `/api/v1/transform/` | Sube un CSV/Excel → devuelve el array `BerthCall` transformado |
| `POST` | `/api/v1/optimize/run` | Ejecuta el optimizador de planificación → devuelve asignaciones + KPIs |
| `POST` | `/api/v1/optimize/replan` | Re-planifica tras retrasos de buques → devuelve el horario actualizado |
| `POST` | `/api/v1/optimize/early_complete` | Gestiona el completado anticipado de una operación de carga → encadena el adelanto (pull-forward) |
| `GET` | `/api/v1/optimize/calibration-stats` | Consulta las estadísticas del modelo de calibración cargado |
| `POST` | `/api/v1/optimize/calibrate` | Carga un CSV histórico y ajusta el modelo de duración |
| `WebSocket` | `/ws/ais-stream` | Relay en vivo de posiciones AIS de buques (difusión a todos los clientes del dashboard conectados) |

---

## Transformador de datos

Procesa ficheros CSV exportados de sistemas de gestión portuaria españoles, con formatos heterogéneos, patrones de fecha inconsistentes y valores ausentes.

### Pipeline

```
Subida de CSV
    │
    ▼
validate_schema          → comprueba que existen las columnas requeridas, lanza un error
                           informativo si falta alguna
    │
    ▼
rename_columns           → mapea los nombres de columna en español de entrada a nombres
                           de campo estandarizados en inglés
    │
    ▼
clean                    → elimina filas completamente vacías, deduplica por
                           (call_id + operation_type), recorta espacios en los campos de texto
    │
    ▼
normalize                → parsea fechas (con varios formatos alternativos), fuerza tipos
                           numéricos, mapea operation_type a un vocabulario controlado
    │
    ▼
merge_concurrent_ops     → fusiona en un único registro las filas donde el mismo buque realiza
                           varias operaciones en el mismo muelle durante exactamente la misma
                           ventana temporal; operation_type pasa a ser, por ejemplo,
                           "Embarque y Trasbordo", las cantidades se suman y los grupos de
                           mercancía se unen con " / "
    │
    ▼
BerthCall[]              → modelos Pydantic validados, listos para el motor de optimización
```

### Mapeo de columnas de entrada → salida

| Entrada (CSV en español) | Campo de salida | Transformación |
|---|---|---|
| `Escala` | `call_id` | string, recorte de espacios |
| `Muelle Real` | `berth_id` | string, recorte de espacios |
| `Noray Inicio` | `noray_start` | float, admite nulo |
| `Noray Fin` | `noray_end` | float, admite nulo |
| `Fecha Atraque Real` | `arrival_time` | datetime (ISO 8601), con varios formatos alternativos |
| `Fecha Desatraque Real` | `departure_time` | datetime (ISO 8601), con varios formatos alternativos |
| `Buque Eslora` | `vessel_length` | float (metros) |
| `Buque GT` | `vessel_gt` | entero |
| `Tipo Operación` | `operation_type` | normalizado a `Embarque` / `Desembarque` / `Trasbordo` (o combinado, p. ej. `Embarque y Trasbordo`) |
| `Grupo Mercancía` | `cargo_group` | string |
| `Naturaleza Mercancia` | `cargo_nature` | string |
| `Cantidad` | `quantity` | float, admite nulo |

### Fusión de operaciones concurrentes

Cuando el mismo buque (`call_id`) realiza dos o más operaciones en el mismo muelle durante exactamente la misma ventana temporal (idéntico `arrival_time` y `departure_time`), las filas se fusionan en una sola:

| Campo | Estrategia de fusión |
|---|---|
| `operation_type` | Tipos unidos en orden de aparición: `"Embarque y Trasbordo"` |
| `cargo_group` / `cargo_nature` | Valores distintos no vacíos unidos con `" / "` |
| `quantity` | Suma de todas las filas (`null` solo si todas las filas son nulas) |
| Resto de campos | Se mantienen los de la primera fila (dimensiones del buque, norays, fechas) |

---

## Optimizador

Algoritmo de planificación en tres fases que minimiza el tiempo total de espera de los buques. La configuración del puerto (muelles, pilotos, remolcadores) la proporciona quien hace la llamada en cada petición — el sistema es **totalmente agnóstico a la configuración**.

Los buques se reparten por fecha de ETA y se optimizan un día cada vez. El estado de los muelles se propaga entre días (un buque atracado el día N sigue ocupando espacio el día N+1); los pools de recursos (pilotos, remolcadores) se reinician cada día, siguiendo la lógica de turnos de personal.

### Fase 1 — Calibración (opcional)

`Calibration(csv_path=None)` aprende modelos estadísticos de duración a partir de un CSV histórico. Se construyen cuatro modelos genéricos — nunca se almacena ningún nombre de muelle:

| Modelo | Clave | Descripción |
|---|---|---|
| `rate_model` | `(tipo_operacion, grupo_mercancia)` | Mediana de t/h (se usa cuando se conoce `cantidad`) |
| `duration_model` | `(tipo_operacion, grupo_mercancia, eslora_bucket)` | Mediana de duración en horas (requiere ≥ 5 observaciones) |
| `overlap_factor_learned` | — | Ratio real / suma-de-individuales para escalas con varias operaciones |
| `maneuver_model` | `(eslora_bucket, hazardous: bool)` | Mediana de duración de una sola maniobra (h) para atraque/desatraque |

Tramos de eslora: `<80 m`, `80–150 m`, `150–220 m`, `>220 m`.

### Fase 2 — Planificación greedy

Dentro de cada muelle, los buques se ordenan por **GT descendente** (mayor tonelaje bruto atraca primero). Para cada buque:

1. Se estima la duración mediante un sistema de tres niveles de respaldo:
   - **Nivel 1** (más preciso): `duracion = cantidad / rate_model`
   - **Nivel 2** (respaldo): duración mediana de `duration_model`
   - **Nivel 3** (último recurso): valor por defecto configurable (48 h por defecto)
2. Se busca el hueco de muelle viable más temprano:
   - Muelles `continuous`: primer rango de norays libre y contiguo
   - Muelles `discrete`: primer slot de capacidad disponible
3. Se aplican las restricciones reales de recursos (ver más abajo); el inicio se retrasa si no hay suficientes pilotos o remolcadores libres en el momento del atraque

#### Regla de los pilotos

Se requiere exactamente **1 piloto** por buque y por maniobra — un evento en el atraque y otro en el desatraque. Un piloto queda ocupado durante la duración devuelta por `estimate_maneuver_duration(eslora, cargo_group, calibration)` en cada maniobra, y después vuelve al pool. Si no hay ningún piloto libre cuando el buque está listo para atracar, el inicio programado se retrasa hasta que uno quede disponible.

#### Regla de los remolcadores

El número de remolcadores necesarios se calcula con `required_tugs(gt, cargo_group, has_bow_thruster)`:

| Rango de GT | Remolcadores base |
|---|---|
| GT < 500 | 0 |
| 500 ≤ GT < 3 000 | 1 |
| 3 000 ≤ GT < 10 000 | 2 |
| 10 000 ≤ GT < 40 000 | 3 |
| GT ≥ 40 000 | 4 |

Modificadores aplicados sobre el valor base:

| Condición | Efecto |
|---|---|
| `cargo_group` es `"Energético"` o `"Químicos"` (mercancía peligrosa) | +1 remolcador |
| `has_bow_thruster = True` | −1 remolcador (mínimo 0) |

El resultado siempre está en **[0, 4]**. Los remolcadores solo se consumen durante la maniobra de atraque y la de desatraque, **no** durante toda la estancia en el muelle. Si hay menos remolcadores disponibles de los necesarios, el buque espera.

#### Modelo de pool de recursos

Los pools de pilotos y remolcadores usan un modelo de disponibilidad **basado en intervalos**: cada unidad mantiene una lista de intervalos ocupados que no se solapan. Esto gestiona correctamente el patrón de consumo en dos eventos — una unidad reservada para atraque a las 08:00–09:00 y pre-reservada para desatraque a las 32:00–33:00 se reporta correctamente como libre en la ventana intermedia. `ResourcePool.copy()` permite que la búsqueda local ramifique el estado del pool sin modificar los pools de quien la llama.

Cuando el atraque de un buque se retrasa por falta de recursos, se marca en la asignación el tipo de recurso responsable (`pilot_caused_delay`, `tug_caused_delay`) para el reporte de KPIs. `pilot_wait_h` y `tug_wait_h` registran las horas reales atribuibles a cada tipo de recurso.

### Fase 3 — Búsqueda local (intercambio intra-muelle, con conciencia de recursos)

Prueba todas las permutaciones por pares dentro de cada muelle. Un intercambio solo se acepta cuando:
- No viola la regla de prioridad por GT (un GT mayor no puede ir después de uno menor si ambos buques estaban disponibles simultáneamente)
- Reduce estrictamente el **tiempo de espera total** del grupo — incluyendo los retrasos provocados por falta de recursos

La conciencia de recursos se logra mediante **background pools**: antes de optimizar cada muelle, los pools de pilotos/remolcadores se precargan con todos los compromisos de maniobra de los mejores horarios actuales de los demás muelles. Cada ordenación candidata se simula contra estos background pools (copiados en profundidad en cada simulación para que las asignaciones nunca se contaminen entre sí). Esto evita que la búsqueda local acepte intercambios que reducen la espera en el muelle pero generan conflictos de recursos con otros muelles.

**Criterios de parada**: 500 iteraciones o ninguna mejora en las últimas 50 iteraciones.

### Re-planificación dinámica (`/replan`)

Re-planifica el horario tras uno o varios retrasos de buques sin descartar todo el horario previo.

**Pasos:**
1. Se aplica el retraso al buque o buques afectados: los retrasos de tipo `arrival` amplían la fase de fondeo; los de tipo `operation` amplían `estimated_duration_h`; los de tipo `early_arrival` adelantan la ETA.
2. Se ejecuta la detección de conflictos (`conflict.py`) — comprueba violaciones de muelle, piloto y remolcador.
3. **Sin conflicto** → el fondeo absorbió el retraso; se devuelve el horario actualizado tal cual.
4. **Con conflicto** → re-ejecución parcial: solo se re-optimizan el muelle o muelles afectados; el resto permanece congelado.

La respuesta incluye `replan_triggered`, `vessels_affected`, `conflicts_found` y un `delay_map` que el frontend usa para dibujar los segmentos rojos de retraso en el Gantt.

### Completado anticipado de la operación de carga (`/early_complete`)

Se llama cuando un buque termina la carga antes de su hora de fin programada.

**Pasos:**
1. Se trunca la fase `ejecucion` en la hora real de finalización.
2. Se busca el hueco de desatraque más temprano respetando la disponibilidad de pilotos y remolcadores; se inserta una fase `waiting_undock` (lila en el Gantt) si los recursos están ocupados.
3. Se actualizan `desatraque` y `scheduled_end`.
4. **Adelanto en cascada (pull-forward)**: si el muelle queda libre significativamente antes, los buques que esperan en fondeo por ese muelle se adelantan al hueco viable más temprano, respetando la disponibilidad de recursos.

### Detección de conflictos (`conflict.py`)

`detect_conflicts(assignments, delays_map, config)` recorre el horario actualizado buscando:

| Tipo de conflicto | Condición |
|---|---|
| `berth` (muelle) | Dos buques en el mismo muelle tienen ventanas `[scheduled_start, scheduled_end)` solapadas |
| `pilot` (piloto) | Más de `num_pilots` buques tienen ventanas de maniobra de atraque/desatraque solapadas |
| `tug` (remolcador) | La suma de `tugs_required` en ventanas de maniobra solapadas supera `num_tugs` |

### Formatos de petición

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
  "base_assignments": [ /* horario actual de /run o de un /replan anterior */ ],
  "delays": [
    { "vessel_id": "T202200020", "delay_h": 3.5, "delay_type": "arrival" }
  ],
  "config": { /* misma config que /run */ },
  "vessels": [ /* datos de entrada originales de los buques */ ]
}
```

Valores de `delay_type`: `"arrival"` (buque retrasado en mar) · `"operation"` (operación de carga alargándose) · `"early_arrival"` (buque llegado antes de su ETA).

**`/early_complete`**
```json
{
  "vessel_id": "T202200020",
  "complete_time": "2024-01-15T18:30:00",
  "base_assignments": [ /* horario actual */ ],
  "config": { /* misma config que /run */ },
  "vessels": [ /* datos de entrada originales de los buques */ ]
}
```

### Formato de respuesta (`/run`)

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

#### Fases de la operación

Cada buque asignado incluye una lista `phases`. Fases estándar:

| Nombre de fase | Descripción |
|---|---|
| `fondeo` | Espera en fondeo — desde la ETA hasta `scheduled_start` |
| `atraque` | Maniobra de atraque |
| `ejecucion` | Operación de carga |
| `desatraque` | Maniobra de desatraque |

Fases adicionales insertadas por la re-planificación / el completado anticipado:

| Nombre de fase | Descripción |
|---|---|
| `delay` | Segmento rojo — marcador visual de retraso de llegada u operación |
| `waiting_undock` | Segmento lila — el buque espera en el muelle recursos para desatracar |
| `early_arrival` | Segmento cian — el buque llegó antes de su ETA |

#### Campos de KPI

| Campo | Descripción |
|---|---|
| `total_waiting_time_h` | Suma de todos los tiempos de espera de los buques tras la búsqueda local |
| `avg_waiting_time_h` | Tiempo de espera medio por buque asignado |
| `berth_utilization` | Porcentaje de ocupación por muelle en la ventana de planificación |
| `unresolved_vessels` | Recuento de asignaciones `unassigned` + `invalid_berth` |
| `improvement_vs_greedy_pct` | Reducción del tiempo de espera lograda por la búsqueda local frente al baseline greedy |
| `conflicts_resolved` | Buques cuyo inicio se retrasó por contención de recursos |
| `duration_source_breakdown` | Recuento de asignaciones por método de estimación de duración |
| `resource_delays.pilot_caused` | Buques retrasados específicamente por falta de pilotos |
| `resource_delays.tug_caused` | Buques retrasados específicamente por falta de remolcadores |

---

## Relay de AIS Stream

Seguimiento de buques en tiempo real para el mapa del Dashboard. El backend de FastAPI actúa como **proxy WebSocket** entre [aisstream.io](https://aisstream.io/) y el dashboard Angular: una única conexión ascendente persistente reenvía los mensajes `PositionReport` a todos los clientes conectados simultáneamente, de modo que solo se consume un slot de clave API de AISStream, sin importar cuántas pestañas estén abiertas.

### Arquitectura

```
aisstream.io  ──wss──►  tarea _relay_loop()  ──difusión──►  Cliente Angular 1
                                                          └──►  Cliente Angular 2
                                                          └──►  Cliente Angular N
```

El relay es una única `asyncio.Task` (`_relay_loop`) que vive durante toda la vida del proceso del servidor. Se inicia automáticamente cuando el primer cliente Angular se conecta a `/ws/ais-stream` y sigue funcionando aunque todos los clientes se desconecten (así la reconexión es instantánea).

### Protocolo de bounding-box

El frontend envía un mensaje `bbox` para restringir qué buques se transmiten. El relay se reconecta a AISStream con el nuevo bounding box tras un **debounce de 1 s**.

```json
{ "type": "bbox", "bbox": [[[swLat, swLng], [neLat, neLng]]] }
```

Bbox por defecto, que cubre la zona del puerto de Las Palmas: `[[[28.06, -15.52], [28.18, -15.36]]]`.

### Reconexión / backoff

| Evento | Comportamiento |
|---|---|
| AISStream cierra la conexión | El relay se reconecta de inmediato; el backoff empieza en 2 s y se duplica hasta 60 s en fallos repetidos |
| Reinicio del backoff | En cada conexión correcta, `backoff` vuelve a 2 s |

---

## Tests

```bash
pytest -v
```

**85 tests** repartidos en diez módulos de test:

| Fichero | Tests | Cobertura |
|---|---|---|
| `test_validator.py` | 8 | Validación de esquema, columnas ausentes, corrección del renombrado |
| `test_cleaner.py` | 7 | Eliminación de filas vacías, deduplicación, recorte de espacios |
| `test_normalizer.py` | 20 | Formatos de fecha alternativos, forzado de tipos, mapeo de operation_type |
| `test_duration.py` | 6 | Sistema de tres niveles de respaldo, solape multi-operación, override del valor proporcionado |
| `test_scheduler.py` | 7 | Prioridad por GT, muelle inválido, no solape de norays continuos, retraso por contención de remolcadores |
| `test_resources.py` | 15 | Tabla de GT de `required_tugs` + modificadores, huecos de intervalo de `ResourcePool`, asignación multi-unidad |
| `test_local_search.py` | 3 | Nunca empeora, se respeta la restricción de GT |
| `test_optimizer.py` | 8 | End-to-end: 2 muelles, 20 muelles, KPIs dinámicos, inyección de calibración |
| `test_maneuver_duration.py` | 5 | Búsqueda en `maneuver_model`, respaldos (sin calibración / tramo ausente), coherencia end-to-end |
| `test_phases.py` | 6 | Invariante de suma de fases, ejecución nunca negativa, fondeo de espera cero, orden de nombres, timestamps consecutivos, vacío en no asignados |

**Rendimiento**: 200 buques / 100 muelles → < 0,1 s (objetivo: < 2 s).

---

## Estructura del proyecto

```
portoptim-backend/
├── main.py                          Punto de entrada de FastAPI
├── requirements.txt
├── .env.example
├── app/
│   ├── config.py                    Configuración con pydantic-settings
│   ├── core/
│   │   └── exceptions.py            Excepciones HTTP personalizadas y sus handlers
│   ├── api/
│   │   └── v1/
│   │       └── routes/
│   │           ├── transformer.py   POST /api/v1/transform/
│   │           └── ais_stream.py    WebSocket /ws/ais-stream — relay de AISStream.io
│   ├── models/
│   │   ├── vessel.py                Modelo Pydantic Vessel
│   │   └── berth_call.py            Modelo Pydantic BerthCall (duration_hours calculado)
│   ├── services/
│   │   └── transformer/
│   │       ├── validator.py         Validación de esquema y renombrado de columnas
│   │       ├── cleaner.py           Deduplicación, filas vacías, espacios, fusión de operaciones concurrentes
│   │       ├── normalizer.py        Parseo de fechas, forzado de tipos, mapeo de vocabulario
│   │       └── transformer_service.py  Orquestador del pipeline (6 etapas)
│   └── utils/
│       └── csv_reader.py            Lector de CSV/Excel con respaldo de codificación
├── optimizer/                       ← Motor de optimización de planificación
│   ├── __init__.py                  Exports públicos
│   ├── models.py                    Modelos Pydantic de entrada/salida (OptimizationRequest/Response,
│   │                                ReplanRequest/Response, EarlyCompleteRequest/Response,
│   │                                VesselDelay), dataclass AssignmentResult,
│   │                                dataclass OperationPhase, build_phases(),
│   │                                función de regla de negocio required_tugs()
│   ├── calibration.py               Fase 1: rate_model, duration_model, overlap_factor,
│   │                                maneuver_model, get_maneuver_duration()
│   ├── duration.py                  Estimador de duración de tres niveles
│   ├── scheduler.py                 Fase 2: planificador greedy, ResourcePool basado en intervalos
│   │                                (con .copy() para la ramificación de la búsqueda local), lógica de recursos de piloto/remolcador
│   ├── local_search.py              Fase 3: heurística de intercambio intra-muelle con conciencia de recursos;
│   │                                los background pools evitan intercambios que generen conflicto de recursos
│   ├── conflict.py                  Detección de conflictos para re-planificación: apply_delays_to_assignments(),
│   │                                detect_conflicts() (muelle / piloto / remolcador)
│   ├── optimizer.py                 Orquestador día a día: optimize(), replan(),
│   │                                early_complete(); cálculo de KPIs; inyección visual de fases
│   │                                delay/early-arrival/waiting_undock
│   └── router.py                    Router de FastAPI (POST /run, /replan, /early_complete,
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

## Relacionado

- **portoptim** — Frontend en Angular que consume esta API ([ver README del frontend](../portoptim/README.md))

---

## Autor

**Aythami Pérez Vega**
Grado en Ingeniería Informática · Universidad de Las Palmas de Gran Canaria
Tutores: **Nelson Monzón** · **Christopher Expósito Izquierdo**
