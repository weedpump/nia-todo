#!/usr/bin/env python3
"""Regression test for pruning stale rate-limit keys and rows."""
import contextlib, sqlite3, sys, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(ROOT/'api'))
import rate_limit as module
from rate_limit import RateLimiter
conn=sqlite3.connect(':memory:'); conn.execute('CREATE TABLE login_rate_limit_attempts (id INTEGER PRIMARY KEY, bucket TEXT, bucket_key TEXT, attempted_at INTEGER)'); conn.execute("INSERT INTO login_rate_limit_attempts(bucket,bucket_key,attempted_at) VALUES('ip','stale',?)",(int(time.time())-3600,))
@contextlib.contextmanager
def fake_get_db(): yield conn
module.get_db=fake_get_db
limiter=RateLimiter(); limiter.api_requests['stale']=[time.time()-120]; limiter.password_reset_attempts['stale']=[time.time()-7200]; limiter.prune_expired()
assert 'stale' not in limiter.api_requests and 'stale' not in limiter.password_reset_attempts
assert conn.execute('SELECT COUNT(*) FROM login_rate_limit_attempts').fetchone()[0]==0
print('✅ Rate-limit stale state is pruned')
