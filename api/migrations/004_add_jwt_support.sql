-- Migration 004: Add JWT support with versioned secrets
-- Created: 2026-05-15
-- Purpose: JWT authentication with revocable tokens
-- NOTE: These columns may already exist from migration 003 (idempotent)

-- Add token_version to users if not exists
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE
-- We handle this idempotently in main.py startup code
-- This migration is a no-op if columns already exist
