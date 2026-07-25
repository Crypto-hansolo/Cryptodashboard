import { z } from 'zod';
import { ConfigError } from '@cid/core';

/**
 * Environment validation.
 *
 * Config is parsed exactly once, at boot, and a failure is fatal. The
 * alternative — reading `process.env.FOO` at the call site — means a typo in a
 * connector's key name surfaces as a silent "source disabled" three hours into a
 * run, which is precisely the failure mode this platform is supposed to detect
 * in other systems.
 *
 * Secrets never appear in the redacted view exposed to the status UI.
 */

/** Coerce the strings that env vars actually are into booleans people expect. */
const boolish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const intWithDefault = (defaultValue: number, min?: number, max?: number) => {
  let schema = z.coerce.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema.default(defaultValue);
};

/** Treats empty strings as absent, which is how docker-compose passes "unset". */
const optionalString = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value));

export const LLM_PROVIDERS = [
  'ollama',
  'lmstudio',
  'openai-compatible',
  'llamacpp',
  'vllm',
  'null',
] as const;
export const llmProviderSchema = z.enum(LLM_PROVIDERS);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

export const envSchema = z.object({
  // ── Runtime ──
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

  // ── Datastores (the only hard requirements) ──
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // ── Web ──
  WEB_PORT: intWithDefault(3000, 1, 65535),
  NEXT_PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  INTERNAL_API_TOKEN: optionalString(),

  // ── LLM ──
  LLM_PROVIDER: llmProviderSchema.default('ollama'),
  LLM_BASE_URL: z.string().default('http://localhost:11434'),
  LLM_MODEL: z.string().default('llama3.1:8b-instruct-q4_K_M'),
  LLM_API_KEY: optionalString(),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_MAX_TOKENS: intWithDefault(1024, 64, 32_768),
  LLM_TIMEOUT_MS: intWithDefault(120_000, 1_000),
  LLM_CONCURRENCY: intWithDefault(2, 1, 64),

  EMBEDDING_PROVIDER: llmProviderSchema.default('ollama'),
  EMBEDDING_BASE_URL: z.string().default('http://localhost:11434'),
  EMBEDDING_MODEL: z.string().default('nomic-embed-text'),
  EMBEDDING_DIMENSIONS: intWithDefault(768, 64, 4096),

  // ── Scheduler ──
  INTERVAL_MARKET_MS: intWithDefault(10_000, 1_000),
  INTERVAL_DERIVATIVES_MS: intWithDefault(30_000, 1_000),
  INTERVAL_NEWS_MS: intWithDefault(60_000, 5_000),
  INTERVAL_SOCIAL_MS: intWithDefault(60_000, 5_000),
  INTERVAL_ONCHAIN_MS: intWithDefault(60_000, 5_000),
  INTERVAL_GITHUB_MS: intWithDefault(60_000, 5_000),
  INTERVAL_GOVERNANCE_MS: intWithDefault(300_000, 10_000),
  INTERVAL_TOKENOMICS_MS: intWithDefault(900_000, 10_000),
  INTERVAL_ENRICHMENT_MS: intWithDefault(15_000, 1_000),
  INGESTION_ENABLED: boolish(true),

  // ── Market providers ──
  COINGECKO_API_KEY: optionalString(),
  COINGECKO_API_TIER: z.enum(['public', 'demo', 'pro']).default('public'),
  COINMARKETCAP_API_KEY: optionalString(),
  BINANCE_API_BASE: z.string().default('https://api.binance.com'),
  BYBIT_API_BASE: z.string().default('https://api.bybit.com'),
  OKX_API_BASE: z.string().default('https://www.okx.com'),
  KRAKEN_API_BASE: z.string().default('https://api.kraken.com'),
  COINBASE_API_BASE: z.string().default('https://api.exchange.coinbase.com'),
  KUCOIN_API_BASE: z.string().default('https://api.kucoin.com'),
  MEXC_API_BASE: z.string().default('https://api.mexc.com'),
  HYPERLIQUID_API_BASE: z.string().default('https://api.hyperliquid.xyz'),
  DEXSCREENER_API_BASE: z.string().default('https://api.dexscreener.com'),
  GECKOTERMINAL_API_BASE: z.string().default('https://api.geckoterminal.com/api/v2'),
  DEFILLAMA_API_BASE: z.string().default('https://api.llama.fi'),

  // ── On-chain ──
  ETHERSCAN_API_KEY: optionalString(),
  ETHERSCAN_API_BASE: z.string().default('https://api.etherscan.io/v2/api'),
  SOLSCAN_API_KEY: optionalString(),
  BLOCKSCOUT_API_BASE: z.string().default('https://eth.blockscout.com/api/v2'),
  ARKHAM_API_KEY: optionalString(),
  NANSEN_API_KEY: optionalString(),
  DUNE_API_KEY: optionalString(),
  GLASSNODE_API_KEY: optionalString(),
  SANTIMENT_API_KEY: optionalString(),
  INTOTHEBLOCK_API_KEY: optionalString(),
  WHALE_THRESHOLD_USD: intWithDefault(1_000_000, 0),

  // ── Social ──
  X_BEARER_TOKEN: optionalString(),
  REDDIT_CLIENT_ID: optionalString(),
  REDDIT_CLIENT_SECRET: optionalString(),
  REDDIT_USER_AGENT: z.string().default('cid/1.0 (crypto-intelligence-dashboard)'),
  YOUTUBE_API_KEY: optionalString(),
  FARCASTER_HUB_URL: z.string().default('https://hub.pinata.cloud'),
  NEYNAR_API_KEY: optionalString(),
  LENS_API_BASE: z.string().default('https://api-v2.lens.dev'),
  TELEGRAM_BOT_TOKEN: optionalString(),
  DISCORD_BOT_TOKEN: optionalString(),

  // ── GitHub ──
  GITHUB_TOKEN: optionalString(),

  // ── Notifications ──
  DISCORD_WEBHOOK_URL: optionalString(),
  TELEGRAM_CHAT_ID: optionalString(),
  SMTP_HOST: optionalString(),
  SMTP_PORT: intWithDefault(587, 1, 65535),
  SMTP_SECURE: boolish(false),
  SMTP_USER: optionalString(),
  SMTP_PASSWORD: optionalString(),
  SMTP_FROM: z.string().default('alerts@example.com'),
  GENERIC_WEBHOOK_URL: optionalString(),

  // ── Limits ──
  RATE_LIMIT_RPM: intWithDefault(300, 1),
  CACHE_TTL_SECONDS: intWithDefault(30, 0),
  MAX_TRACKED_COINS: intWithDefault(500, 1, 10_000),
  MARKET_SNAPSHOT_RETENTION_DAYS: intWithDefault(90, 0),
});

export type Env = z.infer<typeof envSchema>;

/** Keys whose values must never be logged or sent to the browser. */
const SECRET_KEYS = new Set<keyof Env>([
  'DATABASE_URL',
  'REDIS_URL',
  'INTERNAL_API_TOKEN',
  'LLM_API_KEY',
  'COINGECKO_API_KEY',
  'COINMARKETCAP_API_KEY',
  'ETHERSCAN_API_KEY',
  'SOLSCAN_API_KEY',
  'ARKHAM_API_KEY',
  'NANSEN_API_KEY',
  'DUNE_API_KEY',
  'GLASSNODE_API_KEY',
  'SANTIMENT_API_KEY',
  'INTOTHEBLOCK_API_KEY',
  'X_BEARER_TOKEN',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'YOUTUBE_API_KEY',
  'NEYNAR_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'GITHUB_TOKEN',
  'DISCORD_WEBHOOK_URL',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'GENERIC_WEBHOOK_URL',
]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key as keyof Env);
}

/**
 * Parse an environment record.
 *
 * Collects *all* validation problems before failing. Reporting one missing
 * variable per restart is a miserable way to configure 40 providers.
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new ConfigError(`Invalid environment configuration:\n${problems}`, {
    issueCount: result.error.issues.length,
  });
}

let cached: Env | null = null;

/**
 * Process-wide validated config. Cached so that importing this from 40 modules
 * does not re-validate 40 times.
 */
export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Test hook: replace or clear the cached config. */
export function setEnvForTesting(env: Env | null): void {
  cached = env;
}

/**
 * Redacted view, safe for logs, the status endpoint and error reports.
 * Secrets become `set` / `unset` — enough to debug configuration without
 * leaking the value.
 */
export function redactEnv(env: Env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Iterate the schema's keys, not the parsed object's own keys: zod omits
  // absent optionals entirely, and "GITHUB_TOKEN is unset" is exactly the fact
  // someone reads this view to learn.
  for (const key of Object.keys(envSchema.shape) as Array<keyof Env>) {
    const value = env[key];
    if (isSecretKey(key)) {
      out[key] = value === undefined || value === '' ? 'unset' : 'set';
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Parsed CORS allowlist. `['*']` means "allow any origin". */
export function corsOrigins(env: Env): string[] {
  return env.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Per-domain poll cadences, keyed to match `ConnectorDomain`. */
export function intervalsByDomain(env: Env): Record<string, number> {
  return {
    market: env.INTERVAL_MARKET_MS,
    derivatives: env.INTERVAL_DERIVATIVES_MS,
    dex: env.INTERVAL_MARKET_MS,
    news: env.INTERVAL_NEWS_MS,
    social: env.INTERVAL_SOCIAL_MS,
    onchain: env.INTERVAL_ONCHAIN_MS,
    github: env.INTERVAL_GITHUB_MS,
    governance: env.INTERVAL_GOVERNANCE_MS,
    tokenomics: env.INTERVAL_TOKENOMICS_MS,
  };
}

/**
 * Flat provider config handed to connectors.
 *
 * Connectors receive this rather than the whole `Env` so that a connector
 * cannot reach for an unrelated credential, and so the set of values a
 * connector touches is visible in its descriptor.
 */
export function connectorConfig(env: Env): Record<string, string | number | boolean | undefined> {
  return { ...env };
}
