# Data Model

## PostgreSQL Schema

The full DDL lives in `server/schema.sql` and is mounted as a PostgreSQL init script via Docker Compose.

### Extension

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Provides `gen_random_uuid()` for UUID primary key defaults.

### Tables

#### users

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | PRIMARY KEY | `gen_random_uuid()` |
| `username` | `TEXT` | UNIQUE NOT NULL | -- |
| `email` | `TEXT` | UNIQUE NOT NULL | -- |
| `password_hash` | `TEXT` | NOT NULL | -- |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` |

#### canvases

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | PRIMARY KEY | `gen_random_uuid()` |
| `name` | `TEXT` | NOT NULL | -- |
| `owner_id` | `UUID` | NOT NULL, FK -> users(id) | -- |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `now()` |

#### canvas_members

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `canvas_id` | `UUID` | NOT NULL, FK -> canvases(id) ON DELETE CASCADE | -- |
| `user_id` | `UUID` | NOT NULL, FK -> users(id) ON DELETE CASCADE | -- |

Composite primary key: `(canvas_id, user_id)`.

#### shapes

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| `id` | `UUID` | PRIMARY KEY | -- (client-generated) |
| `canvas_id` | `UUID` | NOT NULL, FK -> canvases(id) ON DELETE CASCADE | -- |
| `type` | `TEXT` | NOT NULL | -- |
| `x` | `DOUBLE PRECISION` | NOT NULL | `0` |
| `y` | `DOUBLE PRECISION` | NOT NULL | `0` |
| `width` | `DOUBLE PRECISION` | NOT NULL | `0` |
| `height` | `DOUBLE PRECISION` | NOT NULL | `0` |
| `fill` | `TEXT` | NOT NULL | `''` |
| `stroke` | `TEXT` | NOT NULL | `'#000000'` |
| `stroke_width` | `DOUBLE PRECISION` | NOT NULL | `2` |
| `text` | `TEXT` | nullable | -- |
| `font_size` | `DOUBLE PRECISION` | nullable | -- |
| `opacity` | `DOUBLE PRECISION` | NOT NULL | `1` |
| `border_radius` | `DOUBLE PRECISION` | NOT NULL | `0` |

Note: `id` has no server-side default. UUIDs are generated client-side (`crypto.randomUUID()`) and passed through. The `ON CONFLICT (id) DO NOTHING` clause in insert prevents duplicates.

### Indexes

```sql
CREATE INDEX idx_shapes_canvas ON shapes(canvas_id);
CREATE INDEX idx_canvas_members_user ON canvas_members(user_id);
```

- `idx_shapes_canvas`: Speeds up loading all shapes for a canvas (the most common query).
- `idx_canvas_members_user`: Speeds up "list canvases for user" join query.

### Foreign Key Cascade Rules

| FK | On Delete |
|----|-----------|
| canvases.owner_id -> users.id | NO ACTION (default) |
| canvas_members.canvas_id -> canvases.id | CASCADE |
| canvas_members.user_id -> users.id | CASCADE |
| shapes.canvas_id -> canvases.id | CASCADE |

Deleting a canvas cascades to remove its members and shapes. Deleting a user cascades to remove their memberships (but does NOT cascade to delete canvases they own).

---

## ER Diagram

```
+-------------+       +----------------+       +-------------+
|   users     |       | canvas_members |       |  canvases   |
|-------------|       |----------------|       |-------------|
| id (PK)     |<------| user_id (FK)   |       | id (PK)     |
| username    |       | canvas_id (FK) |------>| name        |
| email       |       +----------------+       | owner_id    |---> users.id
| password_   |                                | created_at  |
|   hash      |                                +------+------+
| created_at  |                                       |
+-------------+                                       | 1:N
                                                      |
                                               +------+------+
                                               |   shapes    |
                                               |-------------|
                                               | id (PK)     |
                                               | canvas_id   |
                                               | type        |
                                               | x, y        |
                                               | width,height|
                                               | fill, stroke|
                                               | stroke_width|
                                               | text        |
                                               | font_size   |
                                               | opacity     |
                                               | border_     |
                                               |   radius    |
                                               +-------------+
```

Relationships:
- users 1:N canvases (via owner_id)
- users M:N canvases (via canvas_members)
- canvases 1:N shapes

---

## TypeScript Types (client/src/types.ts)

### Shape

```typescript
type ShapeType = "rectangle" | "ellipse" | "line" | "text";

interface Shape {
  id: string;          // UUID, client-generated
  type: ShapeType;     // immutable after creation
  x: number;           // top-left X (or line start X)
  y: number;           // top-left Y (or line start Y)
  width: number;       // bounding box width (or line delta X)
  height: number;      // bounding box height (or line delta Y)
  fill: string;        // CSS color, "" for transparent
  stroke: string;      // CSS color
  strokeWidth: number; // pixel width
  text?: string;       // only for type "text"
  fontSize?: number;   // only for type "text"
  opacity?: number;    // 0-1, default 1
  borderRadius?: number; // rounded corners for rectangles, default 0
}
```

### ShapeProps / ShapePatch

```typescript
interface ShapeProps {
  x: number; y: number; width: number; height: number;
  fill: string; stroke: string; strokeWidth: number;
  text?: string; fontSize?: number;
  opacity?: number; borderRadius?: number;
}

type ShapePatch = Partial<ShapeProps>;
```

`ShapeProps` is the set of mutable fields. `ShapePatch` is the partial update payload sent in `update` operations. Shape `id` and `type` are immutable.

### Operation (discriminated union)

```typescript
type Operation =
  | { kind: "add"; shape: Shape }
  | { kind: "update"; shapeId: string; props: ShapePatch }
  | { kind: "delete"; shapeId: string };
```

### UndoEntry

```typescript
interface UndoEntry {
  forward: Operation;   // the operation that was applied
  reverse: Operation;   // the inverse to undo it
}
```

### Presence

```typescript
interface PresenceUser {
  userId: string;
  username: string;
  color: string;       // from CURSOR_PALETTE
}

const CURSOR_PALETTE = [
  "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6"
] as const;
```

### Auth / Canvas Types

```typescript
interface AuthUser { id: string; username: string; email: string; }
interface SignupRequest { username: string; email: string; password: string; }
interface LoginRequest { username: string; password: string; }
interface AuthResponse { token: string; user: AuthUser; }

interface CanvasSummary { id: string; name: string; ownerId: string; createdAt: string; }
interface CanvasMember { userId: string; username: string; }
interface CanvasDetail extends CanvasSummary { shapes: Shape[]; members: CanvasMember[]; }
interface CreateCanvasRequest { name: string; }
interface InviteRequest { identifier: string; }
interface ErrorResponse { error: string; }
```

### ClientMessage / ServerMessage

```typescript
type ClientMessage =
  | { type: "op"; op: Operation; opId: string }
  | { type: "cursor"; x: number; y: number };

type ServerMessage =
  | { type: "init"; shapes: Shape[]; users: PresenceUser[]; seq: number }
  | { type: "op"; op: Operation; userId: string; seq: number; opId: string }
  | { type: "cursor"; userId: string; username: string; x: number; y: number }
  | { type: "join"; user: PresenceUser }
  | { type: "leave"; userId: string }
  | { type: "error"; message: string };
```

---

## Python Type Mirrors (server/app/types.py)

The Python file uses `TypedDict` with camelCase keys to match the JSON wire format. All types mirror the TypeScript definitions exactly.

Key Python types:

| Python | TypeScript | Notes |
|--------|-----------|-------|
| `Shape(TypedDict)` | `interface Shape` | `NotRequired` for optional fields |
| `ShapePatch(TypedDict, total=False)` | `Partial<ShapeProps>` | All fields optional |
| `AddOp`, `UpdateOp`, `DeleteOp` | `Operation` union variants | Separate TypedDicts joined with `\|` |
| `Operation = AddOp \| UpdateOp \| DeleteOp` | `type Operation = ...` | Union alias |
| `ClientMessage = OpClientMessage \| CursorClientMessage` | `type ClientMessage` | Union alias |
| `ServerMessage = InitServerMessage \| ... \| ErrorServerMessage` | `type ServerMessage` | 6-variant union |

### camelCase to snake_case Mapping

The server converts between wire format (camelCase) and database columns (snake_case) using lookup tables defined in `types.py`:

```python
SHAPE_DB_TO_WIRE = {
    "stroke_width": "strokeWidth",
    "font_size": "fontSize",
}
SHAPE_WIRE_TO_DB = {value: key for key, value in SHAPE_DB_TO_WIRE.items()}
```

ws.py also defines local extra mappings for the newer columns:

```python
_EXTRA_DB_TO_WIRE = {"border_radius": "borderRadius"}
_EXTRA_WIRE_TO_DB = {"borderRadius": "border_radius"}
```

| Wire (camelCase) | DB Column (snake_case) | Where Mapped |
|-------------------|----------------------|--------------|
| `strokeWidth` | `stroke_width` | `_row_to_shape`, `_shape_to_columns`, `_persist_update` in ws.py; manual mapping in canvas.py |
| `fontSize` | `font_size` | Same |
| `borderRadius` | `border_radius` | `_EXTRA_DB_TO_WIRE` / `_EXTRA_WIRE_TO_DB` in ws.py |
| `ownerId` | `owner_id` | canvas.py (manual) |
| `createdAt` | `created_at` | canvas.py (manual, `.isoformat()`) |
| `userId` | `user_id` | canvas.py members (manual) |

All other shape column names are identical between wire and DB (`id`, `type`, `x`, `y`, `width`, `height`, `fill`, `stroke`, `opacity`).

---

## Shape Coordinate System

All shapes use a bounding-box model with a top-left origin (standard canvas coordinate system where Y increases downward).

### Rectangle and Ellipse

```
(x, y) +-----------+
       |           |
       |   shape   |  height
       |           |
       +-----------+
           width
```

- `(x, y)` is the top-left corner of the bounding box.
- `width` and `height` define the box dimensions.
- For ellipse, the center is `(x + width/2, y + height/2)` and radii are `(|width|/2, |height|/2)`.

### Line

```
(x, y) *
        \
         \
          \
           * (x + width, y + height)
```

- `(x, y)` is the start point.
- `(x + width, y + height)` is the end point.
- `width` and `height` are deltas (can be negative for lines going left or up).

### Text

- `(x, y)` is the top-left of the text bounding box.
- Text is rendered at `(x, y + fontSize)` because canvas `fillText` uses baseline positioning.
- `width` is estimated at creation time as `text.length * fontSize * 0.6`.
- `height` equals `fontSize`.
