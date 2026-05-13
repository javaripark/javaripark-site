#!/usr/bin/env node
// Scrape javaripark.menudino.com and output public/data/cardapio.json
// Usage: node scripts/sync-cardapio.js
// Requires: npm install puppeteer

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const MENU_URL = 'https://javaripark.menudino.com';
const OUT = path.join(__dirname, '..', 'public', 'data', 'cardapio.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Launching browser…');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log('Navigating to', MENU_URL);
  await page.goto(MENU_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(3000);

  // Wait for category nav to render (CI runners are slower)
  await page.waitForSelector('span.category-nav, [class*="category__"]', { timeout: 30000 });

  // Get all category names from nav (skip DESTAQUES DO DIA)
  const catNames = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span.category-nav, [class*="category__"]')];
    return spans
      .map(s => s.textContent.trim())
      .filter(t => t.length > 1 && t !== 'DESTAQUES DO DIA');
  });
  console.log(`Found ${catNames.length} categories: ${catNames.join(', ')}`);

  // Scroll down slowly to render all section headers
  console.log('Scrolling to render section headers…');
  await page.evaluate(async () => {
    let h = document.body.scrollHeight;
    for (let y = 0; y < h; y += 300) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 300));
      h = document.body.scrollHeight;
    }
  });
  await sleep(1000);

  // Expand each category and extract items
  console.log('Expanding categories…');
  const menu = [];

  for (const catName of catNames) {
    // Click nav to scroll to category
    await page.evaluate(name => {
      const spans = [...document.querySelectorAll('span.category-nav, [class*="category__"]')];
      const target = spans.find(s => s.textContent.trim() === name);
      if (target) target.click();
    }, catName);
    await sleep(800);

    // Check if category section is collapsed (empty cards-list) and click header to expand
    await page.evaluate(name => {
      const sections = document.querySelectorAll('[class*="contentCategories"], .content-categories');
      for (const section of sections) {
        const header = section.querySelector('[class*="categoriesHeader"]');
        if (!header || !header.textContent.includes(name)) continue;
        const cardsList = section.querySelector('.cards-list, [class*="cardsList"]');
        if (!cardsList || cardsList.children.length === 0) {
          header.click();
        }
        break;
      }
    }, catName);
    await sleep(2000);

    // Extract items from this category's cards-list
    const items = await page.evaluate(name => {
      const sections = document.querySelectorAll('[class*="contentCategories"], .content-categories');
      for (const section of sections) {
        const header = section.querySelector('[class*="categoriesHeader"]');
        if (!header || !header.textContent.includes(name)) continue;

        const cardsList = section.querySelector('.cards-list, [class*="cardsList"]');
        if (!cardsList) return [];

        const cards = cardsList.querySelectorAll('[class*="card__"]');
        const results = [];
        const seen = new Set();

        cards.forEach(card => {
          const titleEl = card.querySelector('[data-testid="product-card-title"], [class*="title"]');
          const priceEl = card.querySelector('[class*="price"]');
          const descEl = card.querySelector('[class*="description"]');
          const imgEl = card.querySelector('img');

          if (titleEl) {
            const itemName = titleEl.textContent.trim();
            if (seen.has(itemName) || !itemName) return;
            seen.add(itemName);

            const priceText = priceEl ? priceEl.textContent.trim() : '';
            const priceNum = priceText
              ? parseFloat(priceText.replace('R$', '').replace(/\./g, '').replace(',', '.').trim())
              : 0;

            results.push({
              name: itemName,
              price: priceNum,
              priceFormatted: priceText,
              description: descEl ? descEl.textContent.trim() : '',
              image: imgEl
                ? imgEl.src.replace(/\/small\//, '/large/').replace(/^\/\//, 'https://').split('?')[0]
                : '',
            });
          }
        });

        return results;
      }
      return [];
    }, catName);

    if (items.length > 0) {
      menu.push({ category: catName, items });
      console.log(`  ${catName}: ${items.length} items`);
    } else {
      console.log(`  ${catName}: 0 items (empty or failed)`);
    }
  }

  const totalItems = menu.reduce((a, c) => a + c.items.length, 0);
  console.log(`\nTotal: ${menu.length} categories, ${totalItems} items`);

  if (totalItems === 0) {
    console.error('ERROR: No items extracted. Aborting to preserve existing data.');
    await browser.close();
    process.exit(1);
  }

  const output = {
    lastUpdated: new Date().toISOString(),
    source: 'javaripark.menudino.com',
    categories: menu,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2), 'utf-8');
  console.log('Saved to', OUT);

  await browser.close();
})();
