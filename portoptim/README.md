# PortOptim — Frontend

Interfaz web del sistema de optimización de asignación de muelles (**Berth Allocation Problem**), desarrollada como parte del Trabajo de Fin de Grado en Ingeniería Informática de la Universidad de Las Palmas de Gran Canaria.

---

## Descripción

**PortOptim** es la capa de presentación del sistema de optimización portuaria. Permite a los operadores de puerto cargar datos de escalas, visualizar el estado de los muelles en tiempo real y consultar los resultados generados por el algoritmo de optimización, todo desde una interfaz web intuitiva y profesional.

El frontend actúa como punto de entrada al sistema: recibe los datos crudos del puerto, los envía al transformador de datos y representa visualmente las asignaciones óptimas de muelles calculadas por el algoritmo.

---

## Tecnología

| Elemento | Detalle |
|---|---|
| Framework | [Angular](https://angular.dev/) 19 |
| Lenguaje | TypeScript |
| Estilos | CSS con sistema de diseño propio (tema *Maritime Logistics Excellence*) |
| Tipografía | Inter |
| Herramienta de scaffolding | Angular CLI 19.2.9 |

### ¿Por qué Angular?

Se eligió Angular como framework principal por varias razones:

- **Escalabilidad**: su arquitectura basada en módulos y componentes facilita el crecimiento ordenado del proyecto.
- **TypeScript nativo**: mejora la robustez del código y la detección temprana de errores.
- **Compatibilidad con Angular Ionic**: en caso de querer migrar a una aplicación móvil en el futuro (véase [Trabajo futuro](#trabajo-futuro)), Angular comparte base con Ionic, lo que reduciría significativamente el esfuerzo de adaptación.

---

## Diseño

El sistema de diseño utilizado se denomina **Maritime Logistics Excellence**, creado específicamente para entornos de logística portuaria. Está orientado a operadores en entornos de alta presión y prioriza la claridad y eficiencia en la lectura de datos.

### Paleta de colores principal

| Rol | Color | Uso |
|---|---|---|
| Primary (Navy) | `#000a1e` | Sidebar, cabeceras, branding |
| Accent (Teal) | `#006a6a` | Botones primarios, estados activos |
| Background | `#f8f9ff` | Fondo general de la aplicación |
| Surface | `#ffffff` | Tarjetas y contenedores |
| Error | `#ba1a1a` | Validaciones y alertas |

### Tipografía

Se utiliza **Inter** en todos los elementos por su excelente legibilidad en aplicaciones SaaS con gran densidad de datos. Los tamaños van de `12px` (etiquetas) a `32px` (títulos principales).

### Layout

- Sidebar fijo de `260px` con fondo Navy oscuro.
- Sistema de rejilla de 12 columnas para el contenido principal.
- Unidad base de espaciado: `8px`.
- Bordes redondeados estándar de `8px` en tarjetas, inputs y botones.

---

## Vistas principales

### 1. Dashboard
Vista general del estado del puerto. Muestra métricas clave (buques activos, ocupación de muelles, asignaciones pendientes) y un diagrama de Gantt simplificado con la ocupación de muelles en una ventana de 24 horas.

### 2. Carga de datos (`Data Input`)
Panel de carga de ficheros CSV con el histórico de escalas portuarias. Tras la carga se muestra una previsualización de los datos con las columnas relevantes para el algoritmo:

`Escala`, `Muelle Real`, `Noray Inicio`, `Noray Fin`, `Fecha Atraque Real`, `Fecha Desatraque Real`, `Buque Eslora`, `Buque GT`, `Tipo Operación`, `Grupo Mercancía`, `Cantidad`, `Naturaleza Mercancía`

Incluye indicadores de validación por columna (✅ presente / ⚠️ ausente).

### 3. Resultados de optimización (`Optimization Results`)
Presenta la salida del algoritmo mediante:
- Diagrama de Gantt interactivo (eje X: tiempo, eje Y: muelles).
- Panel de métricas resumen (tiempo de espera ahorrado, utilización de muelles, conflictos resueltos).
- Tabla ordenable con las asignaciones generadas.

### 4. Detalle de buque (`Vessel Detail View`)
Panel lateral o modal que se abre al seleccionar un buque. Muestra todos sus atributos: nombre, GT, eslora, muelle asignado, rango de noray, tipo de operación, tipo de mercancía y ventana temporal.

---

## Estructura del proyecto

```
portoptim/
├── src/
│   ├── app/
│   │   ├── core/                          → CoreModule (servicios globales)
│   │   ├── shared/
│   │   │   ├── components/
│   │   │   │   ├── sidebar/               → Nav lateral Navy con routerLinkActive
│   │   │   │   ├── topbar/                → Header con terminal/notificaciones
│   │   │   │   └── layout/                → Shell con <router-outlet>
│   │   │   └── shared.module.ts
│   │   └── features/                      → Lazy-loaded
│   │       ├── dashboard/
│   │       │   ├── components/
│   │       │   │   ├── metric-card/       → KPI reutilizable con @Input
│   │       │   │   ├── berth-timeline/    → Timeline 24h con datos dinámicos
│   │       │   │   └── action-alerts/     → Panel alertas priorizadas
│   │       │   └── dashboard.component    → Página principal
│   │       ├── data-input/
│   │       │   └── data-input.component   → Drag-drop + tabla preview + validación
│   │       └── optimization/
│   │           ├── components/
│   │           │   └── vessel-detail-panel/ → Slide-over panel con @Input/@Output
│   │           └── optimization.component  → KPIs + Gantt chart clicable
│   ├── assets/
│   └── styles/                            → Estilos globales y variables CSS
├── angular.json
├── package.json
└── README.md
```

### Decisiones de arquitectura destacadas

- **Lazy loading** en todas las rutas de `features/`: cada módulo se carga bajo demanda, mejorando el tiempo de carga inicial de la aplicación.
- **CoreModule**: centraliza los servicios de instancia única (HTTP, estado global, autenticación futura) para evitar duplicidades.
- **SharedModule**: agrupa los componentes reutilizables (`sidebar`, `topbar`, `layout`) que se importan en el resto de módulos.
- **Comunicación entre componentes**: se usa el patrón `@Input`/`@Output` para el paso de datos entre componentes padre e hijo (por ejemplo, `vessel-detail-panel` recibe el buque seleccionado desde `optimization.component` y emite eventos de cierre).

---

## Instalación y ejecución

### Requisitos previos

- Node.js >= 18
- Angular CLI >= 19

```bash
npm install -g @angular/cli
```

### Pasos

```bash
# Clonar el repositorio
git clone <url-del-repositorio>
cd portoptim

# Instalar dependencias
npm install

# Iniciar servidor de desarrollo
ng serve
```

Abre el navegador en `http://localhost:4200/`. La aplicación se recargará automáticamente al modificar cualquier fichero fuente.

### Build de producción

```bash
ng build
```

Los artefactos compilados se generan en el directorio `dist/`.

---

## Trabajo futuro

Una de las decisiones de diseño de este proyecto fue elegir **Angular** como framework web teniendo en mente la posible extensión a una **aplicación móvil nativa** en el futuro. Gracias a la compatibilidad de Angular con **Ionic Framework**, sería posible reutilizar gran parte de la lógica y los componentes existentes para generar una app para iOS y Android sin necesidad de reescribir el proyecto desde cero.

Esta migración no forma parte del alcance actual del TFG, pero se considera una línea de mejora futura relevante para hacer el sistema accesible a operadores de puerto desde dispositivos móviles en campo.

---

## Autor

**Aythami Pérez Vega**  
Grado en Ingeniería Informática  
Universidad de Las Palmas de Gran Canaria  

Tutores: **Nelson Monzón** · **Christopher Expósito Izquierdo**
