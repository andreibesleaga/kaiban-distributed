# Database Schema Documentation
<!-- Physical database schema documentation -->
<!-- Updated by: db-migration.skill -->
<!-- Read by: data-engineering.skill, data-governance.skill -->

---

## Overview
**Database Engine**: [PostgreSQL 16 / MySQL 8 / etc.]
**Migration Tool**: [Prisma / Flyway / Alembic / etc.]
**Last Updated**: [YYYY-MM-DD]

## Tables

### `[table_name]`
[Brief description of what this table represents]

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | UUID | PRIMARY KEY, Default: uuid_generate_v4() | Unique identifier |
| `created_at` | TIMESTAMP | NOT NULL, Default: NOW() | Creation timestamp |
| `updated_at` | TIMESTAMP | NOT NULL, Default: NOW() | Last update timestamp |
| `[column]` | [type] | [constraints] | [description] |

**Indexes**:
- `idx_[table]_[column]` on `([column])`

**Relations**:
- Belongs to `[other_table]` via `[foreign_key]`

---

## Enum Types
### `[enum_name]`
- `[VALUE_1]`
- `[VALUE_2]`

---
