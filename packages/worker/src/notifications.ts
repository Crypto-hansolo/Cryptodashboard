import {
  err,
  formatUsd,
  ok,
  type DomainError,
  type HttpClient,
  type Logger,
  type NotificationChannel,
  type NotificationPayload,
  type Notifier,
  type Result,
} from '@cid/core';
import { noopLogger, UpstreamError } from '@cid/core';
import { metrics, type Env } from '@cid/platform';
import nodemailer from 'nodemailer';

/**
 * Notification channels.
 *
 * Each implements the same `Notifier` port and reports `isConfigured()` so the
 * dispatcher can skip a channel the user has not set up rather than recording a
 * failed delivery for it. Delivery outcomes are persisted, so a channel that is
 * silently broken is visible in the UI rather than merely absent.
 */

function severityColor(importance: number | null): number {
  // Discord embed colours: red for critical, amber for high, blue otherwise.
  if (importance === null) return 0x5865f2;
  if (importance >= 85) return 0xed4245;
  if (importance >= 65) return 0xfaa61a;
  return 0x5865f2;
}

export class DiscordNotifier implements Notifier {
  readonly channel: NotificationChannel = 'DISCORD';
  readonly #http: HttpClient;
  readonly #webhookUrl: string | undefined;

  constructor(http: HttpClient, env: Pick<Env, 'DISCORD_WEBHOOK_URL'>) {
    this.#http = http;
    this.#webhookUrl = env.DISCORD_WEBHOOK_URL;
  }

  isConfigured(): boolean {
    return this.#webhookUrl !== undefined;
  }

  async send(payload: NotificationPayload): Promise<Result<void, DomainError>> {
    if (!this.#webhookUrl) return err(new UpstreamError('discord', 'webhook not configured'));

    const response = await this.#http.request({
      url: this.#webhookUrl,
      method: 'POST',
      body: {
        embeds: [
          {
            title: payload.title.slice(0, 256),
            description: payload.message.slice(0, 4_000),
            ...(payload.url ? { url: payload.url } : {}),
            color: severityColor(payload.importance),
            timestamp: payload.triggeredAt.toISOString(),
            fields: [
              ...(payload.coinSymbol
                ? [{ name: 'Asset', value: payload.coinSymbol, inline: true }]
                : []),
              ...(payload.importance !== null
                ? [{ name: 'Importance', value: `${payload.importance}/100`, inline: true }]
                : []),
              ...(payload.sentiment
                ? [
                    {
                      name: 'Sentiment',
                      value: payload.sentiment.toLowerCase().replace('_', ' '),
                      inline: true,
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    });

    return response.ok ? ok(undefined) : err(response.error);
  }
}

export class TelegramNotifier implements Notifier {
  readonly channel: NotificationChannel = 'TELEGRAM';
  readonly #http: HttpClient;
  readonly #token: string | undefined;
  readonly #chatId: string | undefined;

  constructor(http: HttpClient, env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>) {
    this.#http = http;
    this.#token = env.TELEGRAM_BOT_TOKEN;
    this.#chatId = env.TELEGRAM_CHAT_ID;
  }

  isConfigured(): boolean {
    // Both are needed: a bot token with no chat id has nowhere to send.
    return this.#token !== undefined && this.#chatId !== undefined;
  }

  async send(payload: NotificationPayload): Promise<Result<void, DomainError>> {
    if (!this.#token || !this.#chatId) {
      return err(new UpstreamError('telegram', 'bot token or chat id not configured'));
    }

    // Telegram's MarkdownV2 escaping rules are strict enough that a stray
    // character in a headline breaks the whole message; HTML is far safer.
    const escape = (text: string): string =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const lines = [
      `<b>${escape(payload.title)}</b>`,
      escape(payload.message),
      payload.coinSymbol ? `Asset: <code>${escape(payload.coinSymbol)}</code>` : '',
      payload.importance !== null ? `Importance: ${payload.importance}/100` : '',
      payload.url ? `<a href="${escape(payload.url)}">Source</a>` : '',
    ].filter(Boolean);

    const response = await this.#http.request({
      url: `https://api.telegram.org/bot${this.#token}/sendMessage`,
      method: 'POST',
      body: {
        chat_id: this.#chatId,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      },
    });

    return response.ok ? ok(undefined) : err(response.error);
  }
}

export class EmailNotifier implements Notifier {
  readonly channel: NotificationChannel = 'EMAIL';
  readonly #env: Pick<
    Env,
    'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'SMTP_FROM'
  >;
  readonly #to: string | undefined;
  readonly #logger: Logger;
  #transport: nodemailer.Transporter | null = null;

  constructor(
    env: Pick<
      Env,
      'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'SMTP_FROM'
    >,
    options: { to?: string | undefined; logger?: Logger } = {},
  ) {
    this.#env = env;
    this.#to = options.to ?? env.SMTP_FROM;
    this.#logger = options.logger ?? noopLogger;
  }

  isConfigured(): boolean {
    return this.#env.SMTP_HOST !== undefined && this.#to !== undefined;
  }

  async send(payload: NotificationPayload): Promise<Result<void, DomainError>> {
    if (!this.isConfigured() || !this.#env.SMTP_HOST || !this.#to) {
      return err(new UpstreamError('smtp', 'SMTP_HOST not configured'));
    }

    // Lazily create the transport so an unconfigured channel costs nothing.
    this.#transport ??= nodemailer.createTransport({
      host: this.#env.SMTP_HOST,
      port: this.#env.SMTP_PORT,
      secure: this.#env.SMTP_SECURE,
      ...(this.#env.SMTP_USER && this.#env.SMTP_PASSWORD
        ? { auth: { user: this.#env.SMTP_USER, pass: this.#env.SMTP_PASSWORD } }
        : {}),
    });

    try {
      await this.#transport.sendMail({
        from: this.#env.SMTP_FROM,
        to: this.#to,
        subject: `[CID] ${payload.title}`.slice(0, 200),
        text: [
          payload.message,
          '',
          payload.coinSymbol ? `Asset: ${payload.coinSymbol}` : '',
          payload.importance !== null ? `Importance: ${payload.importance}/100` : '',
          payload.sentiment ? `Sentiment: ${payload.sentiment}` : '',
          payload.url ? `Source: ${payload.url}` : '',
          '',
          `Triggered at ${payload.triggeredAt.toISOString()}`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
      return ok(undefined);
    } catch (error) {
      this.#logger.warn({ err: error }, 'smtp delivery failed');
      return err(new UpstreamError('smtp', error instanceof Error ? error.message : 'send failed'));
    }
  }
}

/** Generic webhook: posts the payload as JSON for the user's own automation. */
export class WebhookNotifier implements Notifier {
  readonly channel: NotificationChannel = 'WEBHOOK';
  readonly #http: HttpClient;
  readonly #url: string | undefined;

  constructor(http: HttpClient, env: Pick<Env, 'GENERIC_WEBHOOK_URL'>) {
    this.#http = http;
    this.#url = env.GENERIC_WEBHOOK_URL;
  }

  isConfigured(): boolean {
    return this.#url !== undefined;
  }

  async send(payload: NotificationPayload): Promise<Result<void, DomainError>> {
    if (!this.#url) return err(new UpstreamError('webhook', 'GENERIC_WEBHOOK_URL not configured'));
    const response = await this.#http.request({
      url: this.#url,
      method: 'POST',
      body: {
        title: payload.title,
        message: payload.message,
        url: payload.url,
        coinSymbol: payload.coinSymbol,
        importance: payload.importance,
        sentiment: payload.sentiment,
        triggeredAt: payload.triggeredAt.toISOString(),
      },
    });
    return response.ok ? ok(undefined) : err(response.error);
  }
}

/**
 * Desktop notifications.
 *
 * The worker cannot raise a browser notification, so this is a no-op that always
 * "succeeds": the trigger row is what the browser polls/streams and renders via
 * the Notification API. Modelled as a Notifier anyway so the dispatcher does not
 * need a special case.
 */
export class DesktopNotifier implements Notifier {
  readonly channel: NotificationChannel = 'DESKTOP';

  isConfigured(): boolean {
    return true;
  }

  async send(): Promise<Result<void, DomainError>> {
    return ok(undefined);
  }
}

/**
 * Fan-out dispatcher.
 *
 * Records a delivery row per channel per trigger, so "did my Discord alert
 * actually send" is answerable. Unconfigured channels are marked SUPPRESSED
 * rather than FAILED — the distinction between "not set up" and "broken" is what
 * makes the status view useful.
 */
export class NotificationDispatcher {
  readonly #notifiers = new Map<NotificationChannel, Notifier>();
  readonly #logger: Logger;

  constructor(notifiers: readonly Notifier[], options: { logger?: Logger } = {}) {
    for (const notifier of notifiers) {
      this.#notifiers.set(notifier.channel as NotificationChannel, notifier);
    }
    this.#logger = (options.logger ?? noopLogger).child({ component: 'notifications' });
  }

  configuredChannels(): NotificationChannel[] {
    return [...this.#notifiers.values()]
      .filter((notifier) => notifier.isConfigured())
      .map((notifier) => notifier.channel as NotificationChannel);
  }

  async dispatch(
    channels: readonly NotificationChannel[],
    payload: NotificationPayload,
  ): Promise<
    Array<{
      channel: NotificationChannel;
      status: 'SENT' | 'FAILED' | 'SUPPRESSED';
      error: string | null;
    }>
  > {
    const outcomes: Array<{
      channel: NotificationChannel;
      status: 'SENT' | 'FAILED' | 'SUPPRESSED';
      error: string | null;
    }> = [];

    for (const channel of channels) {
      const notifier = this.#notifiers.get(channel);

      if (!notifier) {
        outcomes.push({ channel, status: 'SUPPRESSED', error: 'no notifier registered' });
        continue;
      }
      if (!notifier.isConfigured()) {
        outcomes.push({ channel, status: 'SUPPRESSED', error: 'channel not configured' });
        continue;
      }

      const result = await notifier.send(payload);
      if (result.ok) {
        metrics.increment('notifications_sent', { channel });
        outcomes.push({ channel, status: 'SENT', error: null });
      } else {
        this.#logger.warn({ channel, err: result.error.message }, 'notification delivery failed');
        outcomes.push({ channel, status: 'FAILED', error: result.error.message });
      }
    }

    return outcomes;
  }
}

/** Build the alert notification body from a trigger. */
export function buildNotificationPayload(input: {
  title: string;
  message: string;
  url: string | null;
  coinSymbol: string | null;
  importance: number | null;
  sentiment: NotificationPayload['sentiment'];
  triggeredAt: Date;
  observedValue: number | null;
  valueKind?: 'usd' | 'percent' | 'raw';
}): NotificationPayload {
  // Append the observed value so the notification is actionable at a glance
  // rather than requiring a click through to the app.
  const suffix =
    input.observedValue === null
      ? ''
      : input.valueKind === 'usd'
        ? ` (${formatUsd(input.observedValue)})`
        : input.valueKind === 'percent'
          ? ` (${input.observedValue >= 0 ? '+' : ''}${input.observedValue.toFixed(2)}%)`
          : '';

  return {
    title: input.title,
    message: `${input.message}${suffix}`,
    url: input.url,
    coinSymbol: input.coinSymbol,
    importance: input.importance,
    sentiment: input.sentiment,
    triggeredAt: input.triggeredAt,
  };
}
