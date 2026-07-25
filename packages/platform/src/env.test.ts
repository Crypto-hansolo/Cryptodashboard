import { describe, expect, it } from 'vitest';
import {
  connectorConfig,
  corsOrigins,
  intervalsByDomain,
  isSecretKey,
  parseEnv,
  redactEnv,
} from './env.js';

const MINIMAL = {
  DATABASE_URL: 'postgresql://cid:cid@localhost:5432/cid',
  REDIS_URL: 'redis://localhost:6379',
};

describe('parseEnv', () => {
  it('accepts the two required variables and defaults the rest', () => {
    const env = parseEnv(MINIMAL);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LLM_PROVIDER).toBe('ollama');
    expect(env.MAX_TRACKED_COINS).toBe(500);
    expect(env.WEB_PORT).toBe(3000);
  });

  it('fails when a required variable is missing', () => {
    expect(() => parseEnv({ REDIS_URL: 'redis://x' })).toThrow(/DATABASE_URL/);
  });

  it('reports every problem at once rather than one per restart', () => {
    let message = '';
    try {
      parseEnv({ LLM_PROVIDER: 'gpt5', WEB_PORT: 'not-a-port' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('LLM_PROVIDER');
    expect(message).toContain('WEB_PORT');
  });

  it('coerces numeric strings, as env vars always are', () => {
    const env = parseEnv({ ...MINIMAL, INTERVAL_MARKET_MS: '5000', LLM_TEMPERATURE: '0.7' });
    expect(env.INTERVAL_MARKET_MS).toBe(5000);
    expect(env.LLM_TEMPERATURE).toBeCloseTo(0.7);
  });

  it('parses the strings people actually write for booleans', () => {
    for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
      expect(parseEnv({ ...MINIMAL, INGESTION_ENABLED: value }).INGESTION_ENABLED).toBe(true);
    }
    for (const value of ['false', '0', 'no', 'off', '']) {
      expect(parseEnv({ ...MINIMAL, INGESTION_ENABLED: value }).INGESTION_ENABLED).toBe(false);
    }
  });

  it('treats an empty optional string as absent, the way docker-compose passes unset', () => {
    const env = parseEnv({ ...MINIMAL, GITHUB_TOKEN: '', COINGECKO_API_KEY: '   ' });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.COINGECKO_API_KEY).toBeUndefined();
  });

  it('rejects out-of-range numbers', () => {
    expect(() => parseEnv({ ...MINIMAL, WEB_PORT: '99999' })).toThrow();
    expect(() => parseEnv({ ...MINIMAL, LLM_TEMPERATURE: '5' })).toThrow();
    expect(() => parseEnv({ ...MINIMAL, MAX_TRACKED_COINS: '0' })).toThrow();
  });

  it('rejects an unknown LLM provider but accepts the "null" sentinel', () => {
    expect(() => parseEnv({ ...MINIMAL, LLM_PROVIDER: 'llama-cpp' })).toThrow();
    expect(parseEnv({ ...MINIMAL, LLM_PROVIDER: 'null' }).LLM_PROVIDER).toBe('null');
    expect(parseEnv({ ...MINIMAL, LLM_PROVIDER: 'vllm' }).LLM_PROVIDER).toBe('vllm');
  });

  it('enforces a minimum poll interval so a typo cannot DoS a provider', () => {
    expect(() => parseEnv({ ...MINIMAL, INTERVAL_NEWS_MS: '1' })).toThrow();
  });
});

describe('redactEnv', () => {
  it('never emits a secret value', () => {
    const env = parseEnv({
      ...MINIMAL,
      GITHUB_TOKEN: 'ghp_supersecret',
      X_BEARER_TOKEN: 'bearer123',
    });
    const redacted = redactEnv(env);

    expect(redacted.GITHUB_TOKEN).toBe('set');
    expect(redacted.X_BEARER_TOKEN).toBe('set');
    expect(redacted.DATABASE_URL).toBe('set');
    expect(JSON.stringify(redacted)).not.toContain('supersecret');
    expect(JSON.stringify(redacted)).not.toContain('bearer123');
  });

  it('distinguishes unset from set', () => {
    const redacted = redactEnv(parseEnv(MINIMAL));
    expect(redacted.GITHUB_TOKEN).toBe('unset');
  });

  it('passes non-secret values through for debugging', () => {
    const redacted = redactEnv(parseEnv({ ...MINIMAL, LLM_MODEL: 'qwen2.5:7b' }));
    expect(redacted.LLM_MODEL).toBe('qwen2.5:7b');
    expect(redacted.INTERVAL_MARKET_MS).toBe(10_000);
  });
});

describe('isSecretKey', () => {
  it('classifies credentials as secret and plain settings as not', () => {
    expect(isSecretKey('GITHUB_TOKEN')).toBe(true);
    expect(isSecretKey('SMTP_PASSWORD')).toBe(true);
    expect(isSecretKey('DISCORD_WEBHOOK_URL')).toBe(true);
    expect(isSecretKey('LLM_MODEL')).toBe(false);
    expect(isSecretKey('WEB_PORT')).toBe(false);
  });
});

describe('corsOrigins', () => {
  it('splits and trims the allowlist', () => {
    const env = parseEnv({ ...MINIMAL, CORS_ALLOWED_ORIGINS: 'http://a.com, http://b.com ' });
    expect(corsOrigins(env)).toEqual(['http://a.com', 'http://b.com']);
  });

  it('supports the wildcard', () => {
    expect(corsOrigins(parseEnv({ ...MINIMAL, CORS_ALLOWED_ORIGINS: '*' }))).toEqual(['*']);
  });
});

describe('intervalsByDomain', () => {
  it('maps every connector domain to a cadence', () => {
    const intervals = intervalsByDomain(parseEnv(MINIMAL));
    for (const domain of [
      'market',
      'derivatives',
      'dex',
      'news',
      'social',
      'onchain',
      'github',
      'governance',
      'tokenomics',
    ]) {
      expect(intervals[domain]).toBeGreaterThan(0);
    }
  });
});

describe('connectorConfig', () => {
  it('exposes provider settings to connectors', () => {
    const config = connectorConfig(parseEnv({ ...MINIMAL, GITHUB_TOKEN: 'ghp_x' }));
    expect(config.GITHUB_TOKEN).toBe('ghp_x');
    expect(config.BINANCE_API_BASE).toBe('https://api.binance.com');
  });
});
