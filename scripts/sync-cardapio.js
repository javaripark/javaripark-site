#!/usr/bin/env node
// Scrape javaripark.menudino.com and output public/data/cardapio.json
// Usage: node scripts/sync-cardapio.js
// Requires: npm install puppeteer (or puppeteer-core)

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL = 'https://javaripark.menudino.com';
const OUT = path.join(__dirname, '..', 'public', 'data', 'cardapio.json');

(async () => {
  console.log('Launching browser…');
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log('Navigating to', URL);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Scroll slowly to trigger lazy-loading of all category sections
  console.log('Scrolling to load all sections…');
  await page.evaluate(async () => {
    let h = document.body.scrollHeight;
    for (let y = 0; y < h; y += 400) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 350));
      h = document.body.scrollHeight;
    }
    window.scrollTo(0, 0);
  });

  await page.waitForSelector('[class*="contentCategories"]', { timeout: 10000 });

  console.log('Extracting menu data…');
  const menu = await page.evaluate(() => {
    const catDivs = document.querySelectorAll('[class*="contentCategories"]');
    const categories = [];

    catDivs.forEach(div => {
      const headerDiv = div.querySelector('[class*="categoriesHeader"]');
      const catName = headerDiv ? headerDiv.textContent.trim() : 'Outros';
      const cardsList = div.querySelector('[class*="cardsList"]');
      const cards = cardsList ? cardsList.querySelectorAll('[class*="card__"]') : [];
      const items = [];

      cards.forEach(card => {
        const nameEl = card.querySelector('[class*="title"]');
        const priceEl = card.querySelector('[class*="price"]');
        const imgEl = card.querySelector('img');
        const descEl = card.querySelector('[class*="description"]');

        if (nameEl && priceEl) {
          const priceText = priceEl.textContent.trim();
          const priceNum = parseFloat(
            priceText.replace('R$', '').replace('.', '').replace(',', '.').trim()
          );
          items.push({
            name: nameEl.textContent.trim(),
            price: priceNum,
            priceFormatted: priceText,
            description: descEl ? descEl.textContent.trim() : '',
            image: imgEl
              ? imgEl.src.replace(/\/small\//, '/large/').split('?')[0]
              : '',
          });
        }
      });

      if (items.length > 0) categories.push({ category: catName, items });
    });

    return categories;
  });

  const totalItems = menu.reduce((a, c) => a + c.items.length, 0);
  console.log(`Found ${menu.length} categories, ${totalItems} items`);

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
