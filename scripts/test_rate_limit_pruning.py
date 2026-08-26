#!/usr/bin/env python3
"""Regression test for pruning inactive in-memory rate-limit keys."""
import sys
import time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
from rate_limit import RateLimiter
limiter=RateLimiter()
limiter.api_requests['stale']=[time.time()-120]
limiter.password_reset_attempts['stale']=[time.time()-7200]
limiter.prune_expired()
assert 'stale' not in limiter.api_requests
assert 'stale' not in limiter.password_reset_attempts
print('✅ Rate-limit stale keys are pruned')
