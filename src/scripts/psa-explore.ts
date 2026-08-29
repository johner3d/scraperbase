// One-off diagnostic: does PSA's Cloudflare check treat a headed, real
// installed Chrome (not Playwright's bundled Chromium) any differently,
// with ZERO flags stripped and ZERO JS patches -- i.e. still fully honest
// about being automation? Opens the page and waits for you to look.
import readline from 'node:readline/promises';
import { chromium } from 'playwright';
import { PSA_PROFILE_DIR } from '../core/config/config.ts';

async function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
  rl.close();
}

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(PSA_PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
  });
  const page = await context.newPage();
  await page.goto('https://www.psacard.com/auctionprices', { waitUntil: 'load', timeout: 60_000 });

  console.log('\nOpened with your real installed Chrome (unpatched, headed).');
  console.log('Look at the window: does it show the real Auction Prices Realized page,');
  console.log('or the "Performing security verification" Cloudflare page?\n');
  await waitForEnter('Press Enter here once you have looked...');

  console.log('Final URL:', page.url());
  console.log('Title:', await page.title());
  await context.close().catch(() => {});
}

await main();
