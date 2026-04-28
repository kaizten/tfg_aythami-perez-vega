# portoptim-backend

Python REST API for the **PortOptim** maritime berth scheduling system, developed as part of a Final Degree Project (TFG) in Computer Engineering at the Universidad de Las Palmas de Gran Canaria.

---

## Modules

| Module | Status | Description |
|---|---|---|
| `data_transformer` | ✅ Implemented | Transforms heterogeneous Spanish port CSV data into standardised `BerthCall` records |
| `optimization_engine` | 🚧 Scaffold | Berth Allocation Problem (BAP) optimisation algorithm — not yet implemented |

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | [FastAPI](https://fastapi.tiangolo.com/) |
| Validation | [Pydantic v2](https://docs.pydantic.dev/latest/) |
| Data processing | [pandas](https://pandas.pydata.org/) |
| Config management | [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) |
| Server | [uvicorn](https://www.uvicorn.org/) |
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

| Method | Path | Status | Description |
|---|---|---|---|
| `GET` | `/health` | ✅ | Liveness probe |
| `POST` | `/api/v1/transform/` | ✅ | Upload CSV → returns transformed `BerthCall` array |
| `POST` | `/api/v1/optimize/` | 🚧 | Placeholder — returns `501 Not Implemented` |

---

## Data transformer

The transformer is the core implemented module. It processes CSV files exported from Spanish port management systems, which may have heterogeneous formats, inconsistent date patterns, and missing values.

### Pipeline

```
CSV upload
    │
    ▼
validate_schema       → checks required columns exist, raises informative error if missing
    │
    ▼
rename_columns        → maps Spanish input column names to standardised English field names
    │
    ▼
clean                 → removes fully empty rows, deduplicates by (call_id + operation_type),
                        strips whitespace from string fields
    │
    ▼
normalize             → parses dates (multiple format fallbacks), coerces numeric types,
                        maps operation_type to controlled vocabulary
    │
    ▼
BerthCall[]           → validated Pydantic models ready for the optimisation engine
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
| `Tipo Operación` | `operation_type` | normalised to `Embarque` / `Desembarque` / `Trasbordo` |
| `Grupo Mercancía` | `cargo_group` | string |
| `Naturaleza Mercancia` | `cargo_nature` | string |
| `Cantidad` | `quantity` | float, nullable |

### Error handling

Rows with unparseable dates, missing `call_id`, `berth_id`, or vessel dimensions are **skipped with a warning** rather than crashing the pipeline. Every API response includes a `transformation_summary` object:

```json
{
  "transformation_summary": {
    "total_input_rows": 10,
    "valid_rows": 7,
    "skipped_rows": 3,
    "skipped_reasons": [
      "Row skipped — unparseable or missing date for call_id='ESC-006'"
    ]
  },
  "data": [...]
}
```

### BerthCall model

```python
class BerthCall(BaseModel):
    call_id: str
    berth_id: str
    noray_start: Optional[float]
    noray_end: Optional[float]
    arrival_time: datetime
    departure_time: datetime
    vessel_length: float
    vessel_gt: int
    operation_type: str
    cargo_group: str
    cargo_nature: str
    quantity: Optional[float]
    duration_hours: float          # computed: (departure_time - arrival_time) in hours
```

---

## Tests

```bash
pytest -v
```

**35 tests** across three test modules:

| File | Tests | Coverage |
|---|---|---|
| `test_validator.py` | 8 | Schema validation, missing columns, error messages |
| `test_cleaner.py` | 7 | Empty row removal, deduplication, whitespace stripping |
| `test_normalizer.py` | 14 | Date format fallbacks, type coercion, operation_type mapping |

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
│   │           └── optimization.py  POST /api/v1/optimize/ (placeholder)
│   ├── models/
│   │   ├── vessel.py                Vessel Pydantic model
│   │   └── berth_call.py            BerthCall Pydantic model (computed duration_hours)
│   ├── services/
│   │   ├── transformer/
│   │   │   ├── validator.py         Schema validation and column renaming
│   │   │   ├── cleaner.py           Deduplication, empty rows, whitespace
│   │   │   ├── normalizer.py        Date parsing, type coercion, vocabulary mapping
│   │   │   └── transformer_service.py  Pipeline orchestrator
│   │   └── optimization/
│   │       └── optimization_service.py  Empty scaffold — not yet implemented
│   └── utils/
│       └── csv_reader.py            CSV/Excel reader with encoding fallback
└── tests/
    ├── conftest.py
    ├── fixtures/
    │   └── sample_port_data.csv     Sample based on real port dataset columns
    └── test_transformer/
        ├── test_validator.py
        ├── test_cleaner.py
        └── test_normalizer.py
```

---

## Related

- **portoptim** — Angular frontend that consumes this API ([see frontend README](../portoptim/README.md))

---

## Author

**Aythami Pérez Vega**  
Grado en Ingeniería Informática · Universidad de Las Palmas de Gran Canaria  
Tutores: **Nelson Monzón** · **Christopher Expósito Izquierdo**
