-- Allow administrators to disable only the data-minimized Umami update-check event.
INSERT OR IGNORE INTO app_config (key, value)
VALUES ('update_analytics_enabled', 'true');