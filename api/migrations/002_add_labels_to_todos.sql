-- Migration 002: Beispiel - Neues Feld 'labels' zur todos Tabelle hinzufügen
-- Created: 2026-05-15
-- Purpose: Demo wie neue Spalten hinzugefügt werden

-- Labels als JSON-Array (SQLite hat kein nativer Array-Typ)
ALTER TABLE todos ADD COLUMN labels TEXT DEFAULT '[]';

-- Optional: Index für schnellere Label-Queries
CREATE INDEX IF NOT EXISTS idx_todos_labels ON todos(labels);
