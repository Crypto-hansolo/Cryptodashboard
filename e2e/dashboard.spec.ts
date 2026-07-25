import { expect, test, type Page } from '@playwright/test';

/**
 * Wait until the client has hydrated.
 *
 * Keyboard shortcuts are registered in a `useEffect`, so they genuinely do not
 * work until hydration completes — pressing a key right after `goto()` is a race,
 * not a bug in the app. The live-status badge reaching "LIVE" proves the client
 * effect ran *and* the SSE stream connected, which is the earliest point at which
 * the shortcut handler is guaranteed to be attached.
 */
async function waitForHydration(page: Page): Promise<void> {
  await expect(page.getByText('LIVE', { exact: false })).toBeVisible({ timeout: 20_000 });
}

/**
 * End-to-end coverage of the dashboard contract.
 *
 * These assert on behaviour a user depends on — the timeline renders, filters
 * narrow it, the palette finds a coin, the API answers — rather than on exact
 * copy or pixel positions, which would break on every design tweak.
 *
 * Requires a seeded database: `npm run db:seed`.
 */

test.describe('dashboard', () => {
  test('renders the terminal shell with watchlist and timeline', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Crypto Intelligence Terminal')).toBeVisible();

    // Watchlist has seeded coins with quotes.
    const watchlistRows = page.locator('aside li');
    await expect(watchlistRows.first()).toBeVisible();
    expect(await watchlistRows.count()).toBeGreaterThan(0);

    // Timeline has seeded events, each expandable.
    const timelineRows = page.locator('li button[aria-expanded]');
    expect(await timelineRows.count()).toBeGreaterThan(0);
  });

  test('reports live connection status', async ({ page }) => {
    await page.goto('/');
    // The SSE stream connects (or reports why it has not) — either way the badge
    // must reflect a real state rather than staying blank.
    await expect(page.getByText(/LIVE|CONNECTING|RECONNECTING|OFFLINE/)).toBeVisible();
  });

  test('expanding an event reveals its analysis pane', async ({ page }) => {
    await page.goto('/');

    const firstRow = page.locator('li button[aria-expanded]').first();
    await expect(firstRow).toHaveAttribute('aria-expanded', 'false');
    await firstRow.click();
    await expect(firstRow).toHaveAttribute('aria-expanded', 'true');

    // Either an AI summary or the explicit "no analysis yet" note — never blank.
    await expect(
      page.getByText(/Why it matters|No AI analysis yet|Importance/).first(),
    ).toBeVisible();
  });

  test('category filter narrows the timeline', async ({ page }) => {
    await page.goto('/');

    const before = await page.locator('li button[aria-expanded]').count();
    expect(before).toBeGreaterThan(1);

    // The seed includes exactly one SECURITY event.
    await page.getByRole('button', { name: 'Security', exact: true }).click();
    await expect
      .poll(async () => page.locator('li button[aria-expanded]').count(), { timeout: 10_000 })
      .toBeLessThan(before);

    await page.getByRole('button', { name: /Clear filters/ }).click();
    await expect
      .poll(async () => page.locator('li button[aria-expanded]').count(), { timeout: 10_000 })
      .toBe(before);
  });

  test('importance filter narrows the timeline', async ({ page }) => {
    await page.goto('/');
    const before = await page.locator('li button[aria-expanded]').count();

    await page.getByRole('button', { name: '85+', exact: true }).click();
    await expect
      .poll(async () => page.locator('li button[aria-expanded]').count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(before);
  });

  test('command palette opens by keyboard and finds a coin', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);

    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByLabel('Search coins');
    await expect(input).toBeVisible();

    await input.fill('bitcoin');
    // Seeded, so it must come back as already tracked.
    await expect(page.getByRole('option').first()).toBeVisible();
    await expect(page.getByText('tracked').first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(input).not.toBeVisible();
  });

  test('selecting a watchlist coin scopes the timeline to it', async ({ page }) => {
    await page.goto('/');

    const coinButton = page.locator('aside li button[aria-pressed]').first();
    const symbol = (await coinButton.locator('span.font-mono').first().textContent())?.trim();
    expect(symbol).toBeTruthy();

    await coinButton.click();
    await expect(coinButton).toHaveAttribute('aria-pressed', 'true');

    // Every remaining row belongs to that coin.
    await expect
      .poll(
        async () => {
          const symbols = await page
            .locator('li button[aria-expanded]')
            .locator('xpath=../span[1]')
            .allTextContents();
          return symbols.every((text) => text.trim() === symbol);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test('research pane opens with the keyboard shortcut', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);

    // Focus the document body so the shortcut is not swallowed by an input.
    await page.locator('header').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('a');

    await expect(page.getByLabel('Research question')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test.describe('api', () => {
  test('health reports database connectivity', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBe(true);

    const body = (await response.json()) as {
      status: string;
      checks: Record<string, { ok: boolean }>;
    };
    expect(body.checks.database?.ok).toBe(true);
    expect(['ok', 'degraded']).toContain(body.status);
  });

  test('timeline paginates with a stable cursor', async ({ request }) => {
    const first = await request.get('/api/timeline?limit=3&collapse=false');
    const firstBody = (await first.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.items.length).toBeLessThanOrEqual(3);

    if (firstBody.nextCursor) {
      const second = await request.get(
        `/api/timeline?limit=3&collapse=false&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      );
      const secondBody = (await second.json()) as { items: Array<{ id: string }> };

      // No overlap between pages — the property OFFSET pagination loses.
      const firstIds = new Set(firstBody.items.map((item) => item.id));
      expect(secondBody.items.some((item) => firstIds.has(item.id))).toBe(false);
    }
  });

  test('rejects an invalid query with a 400 and a reason', async ({ request }) => {
    const response = await request.get('/api/timeline?minImportance=999');
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toContain('minImportance');
  });

  test('keyword search finds a seeded event', async ({ request }) => {
    const response = await request.get('/api/search?q=binance');
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { results: Array<{ headline: string }> };
    expect(body.results.length).toBeGreaterThan(0);
  });

  test('metrics exposes Prometheus text', async ({ request }) => {
    const response = await request.get('/api/metrics');
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('text/plain');
    expect(await response.text()).toContain('# TYPE');
  });

  test('chart returns aligned series for a tracked coin', async ({ request }) => {
    const coins = (await (await request.get('/api/coins')).json()) as {
      items: Array<{ id: string }>;
    };
    const coinId = coins.items[0]?.id;
    expect(coinId).toBeTruthy();

    const response = await request.get(`/api/chart/${coinId}?range=7d`);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      range: string;
      price: Array<{ t: string; price: number }>;
    };
    expect(body.range).toBe('7d');
    // The seed writes 7 days of 30-minute history.
    expect(body.price.length).toBeGreaterThan(0);
  });

  test('ask returns an evidence-grounded answer without a model', async ({ request }) => {
    const response = await request.post('/api/ask', {
      data: { question: 'What happened with Binance?', stream: false },
    });
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      answer: string;
      citations: unknown[];
      noEvidence: boolean;
    };
    // LLM_PROVIDER=null in E2E: the answer says so, but the evidence is real.
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.noEvidence).toBe(false);
    expect(body.citations.length).toBeGreaterThan(0);
  });
});
