"""Read-only investigation, stable state snapshots, and consistent copies."""

from __future__ import annotations

import hashlib
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import time


TABLES = {
    "products": ("sku", "name", "on_hand"),
    "orders": ("id", "customer", "sku", "quantity", "source_reference", "status", "created_at"),
    "inventory_movements": ("id", "order_id", "sku", "delta", "reason", "reverses_movement_id"),
    "repair_runs": ("id", "plan_json"),
}

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE products (
    sku TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    on_hand INTEGER NOT NULL CHECK (on_hand >= 0)
);
CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    sku TEXT NOT NULL REFERENCES products(sku),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    source_reference TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
    created_at TEXT NOT NULL
);
CREATE TABLE inventory_movements (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    sku TEXT NOT NULL REFERENCES products(sku),
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('sale', 'repair_compensation')),
    reverses_movement_id TEXT UNIQUE REFERENCES inventory_movements(id)
);
CREATE TABLE repair_runs (
    id TEXT PRIMARY KEY,
    plan_json TEXT NOT NULL
);
"""


def readonly(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def snapshot(path: Path) -> dict:
    with closing(readonly(path)) as conn:
        return {
            table: [
                dict(row)
                for row in conn.execute(
                    f"SELECT {', '.join(columns)} FROM {table} ORDER BY {columns[0]}"
                )
            ]
            for table, columns in TABLES.items()
        }


def fingerprint(state: dict) -> str:
    value = json.dumps(state, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(value).hexdigest()


def copy_database(source: Path, destination: Path) -> None:
    if source.resolve() == destination.resolve():
        raise ValueError("The rehearsal database must differ from the original.")
    if destination.exists():
        raise ValueError("Refusing to overwrite an existing rehearsal database.")
    with closing(readonly(source)) as src, closing(sqlite3.connect(destination)) as dest:
        src.backup(dest)


def schema_for_agent(path: Path) -> list[dict]:
    with closing(readonly(path)) as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
        ]


def query_database(path: Path, sql: str, max_rows: int = 100, timeout: float = 1.0) -> dict:
    if not isinstance(sql, str) or not sql.strip() or len(sql) > 12_000:
        raise ValueError("Supply one SQL statement of at most 12000 characters.")
    if type(max_rows) is not int or not 1 <= max_rows <= 200:
        raise ValueError("max_rows must be an integer from 1 to 200.")
    allowed_tables = {*TABLES, "sqlite_master", "sqlite_schema"}
    safe_functions = {
        "count", "sum", "min", "max", "avg", "coalesce", "ifnull", "nullif",
        "lower", "upper", "length", "substr", "substring", "trim", "round",
        "abs", "total", "group_concat", "printf", "like", "glob",
        "row_number", "rank", "dense_rank", "lag", "lead",
    }

    def authorize(action, arg1, arg2, database, trigger):
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_RECURSIVE):
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_READ:
            # SQLite reports database=None and column="" for COUNT(*).
            main_read = database == "main" or (database is None and arg2 == "")
            return sqlite3.SQLITE_OK if main_read and arg1 in allowed_tables else sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION:
            return sqlite3.SQLITE_OK if (arg2 or "").lower() in safe_functions else sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_DENY

    conn = readonly(path)
    try:
        conn.enable_load_extension(False)
        conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1_000_000)
        conn.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 12_000)
        conn.set_authorizer(authorize)
        deadline = time.monotonic() + min(max(timeout, 0.01), 2.0)
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        cursor = conn.execute(sql)
        rows = cursor.fetchmany(max_rows + 1)
        return {
            "columns": [item[0] for item in (cursor.description or [])],
            "rows": [dict(row) for row in rows[:max_rows]],
            "truncated": len(rows) > max_rows,
        }
    except sqlite3.Error as exc:
        raise ValueError(f"Read-only query rejected or interrupted: {exc}") from None
    finally:
        conn.close()
