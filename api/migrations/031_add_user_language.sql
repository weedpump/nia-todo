-- Migration 031: Add user language preference for i18n emails
-- Created: 2026-05-24
-- Purpose: Store user language preference server-side for email templates

ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'auto';
