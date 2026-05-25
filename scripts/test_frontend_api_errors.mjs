#!/usr/bin/env node
import { apiErrorFromResponse } from '../web/static/js/api/errors.js';

async function captureApiError(payload) {
  const response = new Response(JSON.stringify(payload), {
    status: 400,
    statusText: 'Bad Request',
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    await apiErrorFromResponse(response, 'fallback message');
  } catch (error) {
    return error;
  }
  throw new Error('apiErrorFromResponse should throw');
}

const flatError = await captureApiError({
  detail: 'Password must be at least 12 characters long',
  code: 'validation.passwordTooShort',
  params: { min: 12 },
});
if (flatError.code !== 'validation.passwordTooShort') throw new Error('Flat APIError code was not preserved');
if (flatError.params?.min !== 12) throw new Error('Flat APIError params were not preserved');
if (flatError.detail !== 'Password must be at least 12 characters long') throw new Error('Flat APIError detail was not preserved');

const nestedError = await captureApiError({
  detail: {
    detail: 'Too many requests. Please slow down.',
    code: 'rateLimit.api',
    params: { retryAfter: 30 },
  },
});
if (nestedError.code !== 'rateLimit.api') throw new Error('Nested APIError code was not preserved');
if (nestedError.params?.retryAfter !== 30) throw new Error('Nested APIError params were not preserved');
if (nestedError.detail !== 'Too many requests. Please slow down.') throw new Error('Nested APIError detail was not preserved');

console.log('✅ Frontend API error adapter flat+nested contract passed');
