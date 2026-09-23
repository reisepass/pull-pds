import { describe, it, expect } from 'vitest';
import {
  classifyError,
  partitionErrors,
  type ErrorCodeCount,
} from '../src/genai/error-classify.js';

describe('classifyError - the OpenAI 429 trap', () => {
  it('splits OpenAI 429 by code: rate_limit_exceeded=health, insufficient_quota=account', () => {
    // Identical HTTP status, opposite meaning. Status alone must NOT decide.
    expect(classifyError('openai', 'rate_limit_exceeded', 429)).toBe('health');
    expect(classifyError('openai', 'insufficient_quota', 429)).toBe('account');
  });

  it('does not let HTTP 429 alone override an account code', () => {
    // Even with a 429 status, an account code stays account.
    expect(classifyError('openai', 'insufficient_quota', 429)).toBe('account');
  });
});

describe('classifyError - provider health codes', () => {
  it('Anthropic 529 overloaded_error and rate_limit_error are health', () => {
    expect(classifyError('anthropic', 'overloaded_error', 529)).toBe('health');
    expect(classifyError('anthropic', 'rate_limit_error', 429)).toBe('health');
    expect(classifyError('anthropic', 'api_error', 500)).toBe('health');
  });

  it('Bedrock ThrottlingException is health but ServiceQuotaExceededException is account', () => {
    // Bedrock keys off the exception NAME, not status: both throttle and
    // ServiceQuota can surface oddly (quota is HTTP 400, not 429).
    expect(classifyError('aws.bedrock', 'ThrottlingException', 429)).toBe('health');
    expect(classifyError('aws.bedrock', 'ModelNotReadyException', 429)).toBe('health');
    expect(classifyError('aws.bedrock', 'ServiceQuotaExceededException', 400)).toBe('account');
    expect(classifyError('aws.bedrock', 'AccessDeniedException', 403)).toBe('account');
  });

  it('Gemini canonical status strings classify, but RESOURCE_EXHAUSTED is left ambiguous', () => {
    expect(classifyError('gcp.gemini', 'UNAVAILABLE', 503)).toBe('health');
    expect(classifyError('gcp.gemini', 'INTERNAL', 500)).toBe('health');
    expect(classifyError('gcp.gemini', 'PERMISSION_DENIED', 403)).toBe('account');
    // RESOURCE_EXHAUSTED conflates rate-limit and quota; not in the table, and
    // 429 is not auto-health, so it lands unclassified rather than mislabeled.
    expect(classifyError('gcp.gemini', 'RESOURCE_EXHAUSTED', 429)).toBe('unclassified');
  });
});

describe('classifyError - account codes', () => {
  it('auth, billing, content-policy, and malformed are account across providers', () => {
    expect(classifyError('openai', 'invalid_api_key', 401)).toBe('account');
    expect(classifyError('openai', 'content_policy_violation', 400)).toBe('account');
    expect(classifyError('openai', 'context_length_exceeded', 400)).toBe('account');
    expect(classifyError('anthropic', 'authentication_error', 401)).toBe('account');
    expect(classifyError('anthropic', 'billing_error', 402)).toBe('account');
  });
});

describe('classifyError - provider aliases and case-insensitivity', () => {
  it('accepts gen_ai.provider.name variants and common aliases', () => {
    expect(classifyError('bedrock', 'throttlingexception')).toBe('health');
    expect(classifyError('gcp.vertex_ai', 'UNAVAILABLE')).toBe('health');
    expect(classifyError('azure', 'DeploymentNotFound')).toBe('account');
    expect(classifyError('GEMINI', 'internal')).toBe('health');
  });
});

describe('classifyError - never silently drop', () => {
  it('an unknown code with no status is unclassified, not dropped', () => {
    expect(classifyError('openai', 'some_brand_new_code')).toBe('unclassified');
  });

  it('an unknown code falls back to a weak HTTP-status signal (5xx=health)', () => {
    expect(classifyError('openai', 'unheard_of', 503)).toBe('health');
    // but an ambiguous 429/4xx stays unclassified
    expect(classifyError('openai', 'unheard_of', 429)).toBe('unclassified');
    expect(classifyError('openai', 'unheard_of', 401)).toBe('unclassified');
  });

  it('an unknown provider entirely still classifies by status fallback only', () => {
    expect(classifyError('some-new-provider', 'weird', 500)).toBe('health');
    expect(classifyError('some-new-provider', 'weird')).toBe('unclassified');
  });
});

describe('classifyError - transport-level codes (no HTTP response at all)', () => {
  it('treats a timeout and a connection failure as provider health, for any provider', () => {
    // ERROR-CLASSIFICATION INCLUDEs timeouts; LiteLLM's Timeout and
    // APIConnectionError are both H. An active prober that reaches nothing is
    // the same shared availability signal as a 503.
    expect(classifyError('openai', 'timeout')).toBe('health');
    expect(classifyError('anthropic', 'connection_error')).toBe('health');
    expect(classifyError('some-new-provider', 'timeout')).toBe('health');
  });

  it('lets a provider-specific meaning win over the transport table', () => {
    // Anthropic's own `timeout_error` (504) is a distinct string and still
    // resolves through the provider table.
    expect(classifyError('anthropic', 'timeout_error', 504)).toBe('health');
  });

  it('does not invent finer transport codes it cannot actually distinguish', () => {
    // A DNS or TLS failure is indistinguishable from the observer's own network
    // being broken, so no such code exists; anything that is not a timeout is
    // reported as connection_error and nothing else is silently assumed.
    expect(classifyError('openai', 'dns_failure')).toBe('unclassified');
    expect(classifyError('openai', 'tls_error')).toBe('unclassified');
  });
});

describe('partitionErrors - publisher-side filter', () => {
  const codes: ErrorCodeCount[] = [
    { code: 'rate_limit_exceeded', count: 12, httpStatus: 429 }, // health
    { code: '503', count: 3, httpStatus: 503 }, // health (via status fallback)
    { code: 'insufficient_quota', count: 7, httpStatus: 429 }, // account -> DROPPED
    { code: 'invalid_api_key', count: 2, httpStatus: 401 }, // account -> DROPPED
    { code: 'brand_new_code', count: 1 }, // unclassified -> VISIBLE
  ];

  it('routes health into errors[], drops account, keeps unclassified visible', () => {
    const p = partitionErrors('openai', codes);
    expect(p.health.map((c) => c.code)).toEqual(['rate_limit_exceeded', '503']);
    expect(p.account.map((c) => c.code)).toEqual(['insufficient_quota', 'invalid_api_key']);
    expect(p.unclassified.map((c) => c.code)).toEqual(['brand_new_code']);
  });

  it('account-scoped codes never appear in the health bucket (privacy property)', () => {
    const p = partitionErrors('openai', codes);
    const healthCodes = p.health.map((c) => c.code);
    expect(healthCodes).not.toContain('insufficient_quota');
    expect(healthCodes).not.toContain('invalid_api_key');
  });

  it('strips the httpStatus helper field from the output counts', () => {
    const p = partitionErrors('openai', codes);
    for (const c of [...p.health, ...p.account, ...p.unclassified]) {
      expect(c).not.toHaveProperty('httpStatus');
    }
  });
});
