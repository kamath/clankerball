import { chromium } from "playwright";

const URL = "http://localhost:3411/";
const OUT = "/tmp/bball";

const b = await chromium.launch({ headless: false, channel: "chrome" });
const page = await b.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

// Let the sim run a bit (rAF pumps because headed).
const score0 = await page.locator("text=FABLE FIELDHOUSE").first().isVisible();
console.log("header visible:", score0);
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}-1-sim.png` });

// Box score tab
await page.getByRole("tab", { name: /box score/i }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}-2-box.png` });

// Edit tab
await page.getByRole("tab", { name: /^edit$/i }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}-3-edit.png` });

// Teams tab -> load a real matchup (Celtics vs Thunder if present)
await page.getByRole("tab", { name: /teams/i }).click();
await page.waitForTimeout(400);
const selects = page.locator('[role="combobox"]');
const nSel = await selects.count();
console.log("selects found:", nSel);
let loaded = false;
if (nSel >= 2) {
  await selects.nth(0).click();
  await page.waitForTimeout(300);
  await page.getByRole("option", { name: /Boston Celtics/i }).click();
  await selects.nth(1).click();
  await page.waitForTimeout(300);
  await page.getByRole("option", { name: /Oklahoma City Thunder/i }).click();
  await page.getByRole("button", { name: /load matchup/i }).click();
  // wait for build (server action pulls + computes)
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${OUT}-4-loaded.png` });
  loaded = true;
  // check box score for real names + ratings
  await page.getByRole("tab", { name: /box score/i }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}-5-realbox.png` });
  const bodyText = await page.locator("body").innerText();
  for (const name of ["Shai", "Tatum", "Holmgren", "White"]) {
    console.log(`  contains ${name}:`, bodyText.includes(name));
  }
}

console.log("loaded matchup:", loaded);
console.log("console/page errors:", errors.length ? errors.slice(0, 8) : "none");
await b.close();
