import { expect, test } from '@playwright/test';

test('renders the landing page and redirects unauthenticated dashboard navigation to login', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Media processing');
  await page.getByRole('link', { name: 'Open dashboard' }).click();
  // /dashboard is a protected route (apps/web/proxy.ts): without a media_refresh
  // cookie, visitors are redirected to /login with the originally requested
  // path preserved in the `from` query param.
  await expect(page).toHaveURL(/\/login\?from=%2Fdashboard$/);
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
});
