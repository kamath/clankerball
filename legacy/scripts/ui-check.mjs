/* Drive the lab + coach UI end to end in a real browser and screenshot.
   Run with: node scripts/ui-check.mjs */
import { chromium } from "playwright";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) =>
  page.screenshot({ path: `/tmp/bball-${name}.png`, fullPage: false });

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await sleep(1500);

// --- Lab: compile instructions for the Firepower offense, stage, run ---
await page.getByRole("button", { name: "Lab" }).click();
await sleep(500);
await page.getByRole("button", { name: "Firepower" }).click();
await sleep(800);
await shot(page, "1-lab-initial");

await page
  .getByPlaceholder(/pick and roll/)
  .fill("team initiative: pick and roll, jokic screener, curry ball handler. get steph open for threes.");
await page
  .getByPlaceholder(/switch everything/)
  .fill("2-3 zone, no gambling for steals");
await page.getByRole("button", { name: /Compile & stage/ }).click();
// compilation finished once the offense plan card shows up
await page.waitForSelector("text=Firepower Five — offense", { timeout: 120000 });
await sleep(1500);
await shot(page, "2-lab-compiled");

await page.getByRole("button", { name: "Run play" }).click();
await sleep(9000);
await shot(page, "3-lab-ran");

// --- Coach: standing instructions for the live game ---
await page.getByRole("button", { name: "Game", exact: true }).click();
await sleep(300);
await page.getByRole("tab", { name: "Coach" }).click();
await sleep(300);
await page.locator("textarea").first().fill("slow the game down, run everything through Caruso");
await page.getByRole("button", { name: /Apply instructions/ }).first().click();
await page.waitForSelector("text=Active plan", { timeout: 120000 });
await sleep(500);
await shot(page, "4-coach-applied");

await browser.close();
console.log("UI check done");
