(function () {
  'use strict';

  const WHATSAPP_NUMBER = '551120811544';
  const DISCOUNT = 0.05;   // desconto do pacote, sobre o subtotal dos itens
  const SERVICE = 0.10;    // serviço, sobre o valor JÁ com desconto (base = subtotal - desconto)

  let menu = [];
  let cart = {};
  let activeCategory = 0;

  const $catTabs = document.getElementById('catTabs');
  const $arrowLeft = document.getElementById('catArrowLeft');
  const $arrowRight = document.getElementById('catArrowRight');
  const $grid = document.getElementById('itemsGrid');
  const $empty = document.getElementById('itemsEmpty');
  const $bar = document.getElementById('cotacaoBar');
  const $barItems = document.getElementById('barItemCount');
  const $barFinal = document.getElementById('barFinal');
  const $barCTA = document.getElementById('barCTA');
  const $modal = document.getElementById('reviewModal');
  const $modalList = document.getElementById('modalList');
  const $modalSubtotal = document.getElementById('modalSubtotal');
  const $modalDiscountVal = document.getElementById('modalDiscountVal');
  const $modalServiceVal = document.getElementById('modalServiceVal');
  const $modalFinal = document.getElementById('modalFinal');
  const $modalSend = document.getElementById('modalSend');
  const $modalClose = document.getElementById('modalClose');
  const $modalBackdrop = document.getElementById('modalBackdrop');

  function formatBRL(val) {
    return 'R$ ' + val.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function cartKey(catIdx, itemIdx) {
    return catIdx + ':' + itemIdx;
  }

  function totalItems() {
    let count = 0;
    for (const k in cart) count += cart[k];
    return count;
  }

  function subtotal() {
    let sum = 0;
    for (const k in cart) {
      if (cart[k] <= 0) continue;
      const [ci, ii] = k.split(':').map(Number);
      const item = menu[ci]?.items[ii];
      if (item && item.price) sum += item.price * cart[k];
    }
    return sum;
  }

  // Cálculo canônico do pacote: desconto de 5% sobre o subtotal, e serviço de 10%
  // sobre o valor JÁ com desconto. Fonte única pra barra, modal e mensagem do WhatsApp.
  function calcTotais() {
    const sub = subtotal();
    const discountVal = sub * DISCOUNT;
    const afterDiscount = sub - discountVal;
    const serviceVal = afterDiscount * SERVICE;
    const total = afterDiscount + serviceVal;
    return { sub, discountVal, serviceVal, total };
  }

  function updateBar() {
    const count = totalItems();
    const { total } = calcTotais();

    $barItems.textContent = count + (count === 1 ? ' item' : ' itens');
    $barFinal.textContent = formatBRL(total);

    if (count > 0) {
      $bar.classList.remove('hidden');
      requestAnimationFrame(() => $bar.classList.add('visible'));
    } else {
      $bar.classList.remove('visible');
      setTimeout(() => {
        if (totalItems() === 0) $bar.classList.add('hidden');
      }, 350);
    }

    highlightSelectedCards();
  }

  function highlightSelectedCards() {
    document.querySelectorAll('.item-card').forEach(card => {
      const key = card.dataset.key;
      const qty = cart[key] || 0;
      card.classList.toggle('selected', qty > 0);
      const valEl = card.querySelector('.qty-val');
      const minusBtn = card.querySelector('.qty-btn');
      if (valEl) valEl.textContent = qty;
      if (minusBtn) minusBtn.classList.toggle('disabled', qty <= 0);
    });
  }

  function renderTabs() {
    $catTabs.innerHTML = '';
    menu.forEach((cat, idx) => {
      const btn = document.createElement('button');
      btn.className = 'cat-tab' + (idx === activeCategory ? ' active' : '');
      btn.textContent = cat.category;
      btn.addEventListener('click', () => {
        activeCategory = idx;
        document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        renderItems();
      });
      $catTabs.appendChild(btn);
    });
  }

  function renderItems() {
    const cat = menu[activeCategory];
    if (!cat || cat.items.length === 0) {
      $grid.innerHTML = '';
      $empty.classList.remove('hidden');
      return;
    }
    $empty.classList.add('hidden');

    $grid.innerHTML = '';
    cat.items.forEach((item, idx) => {
      const key = cartKey(activeCategory, idx);
      const qty = cart[key] || 0;
      const hasPrice = item.price !== null && item.price > 0;

      const card = document.createElement('div');
      card.className = 'item-card' + (qty > 0 ? ' selected' : '');
      card.dataset.key = key;

      let priceHTML;
      if (hasPrice) {
        // O cardapio.json é regenerado pelo sync do Consumer POS todo dia e traz
        // só {name, price} — por isso formatamos aqui, sem depender de priceFormatted.
        priceHTML = '<span class="item-price">' + formatBRL(item.price) + '</span>';
      } else {
        priceHTML = '<span class="item-price-variable">Consultar</span>';
      }

      let descHTML = '';
      if (item.description) {
        descHTML = '<p class="item-desc">' + item.description + '</p>';
      }

      card.innerHTML =
        '<div class="item-info">' +
          '<p class="item-name">' + item.name + '</p>' +
          descHTML +
          priceHTML +
        '</div>' +
        (hasPrice ?
          '<div class="item-qty">' +
            '<button class="qty-btn minus' + (qty <= 0 ? ' disabled' : '') + '" aria-label="Remover">−</button>' +
            '<span class="qty-val">' + qty + '</span>' +
            '<button class="qty-btn plus" aria-label="Adicionar">+</button>' +
          '</div>' : '');

      if (hasPrice) {
        const minus = card.querySelector('.minus');
        const plus = card.querySelector('.plus');
        minus.addEventListener('click', (e) => {
          e.stopPropagation();
          if ((cart[key] || 0) > 0) {
            cart[key]--;
            if (cart[key] === 0) delete cart[key];
            updateBar();
          }
        });
        plus.addEventListener('click', (e) => {
          e.stopPropagation();
          cart[key] = (cart[key] || 0) + 1;
          updateBar();
        });
      }

      $grid.appendChild(card);
    });
  }

  // Itens selecionados no formato {nome, qtd, preco, total} — usado pela mensagem e pelo PDF.
  function itensSelecionados() {
    const out = [];
    for (const k in cart) {
      if (cart[k] <= 0) continue;
      const [ci, ii] = k.split(':').map(Number);
      const item = menu[ci]?.items[ii];
      if (!item || !item.price) continue;
      out.push({ nome: item.name, qtd: cart[k], preco: item.price, total: item.price * cart[k] });
    }
    return out;
  }

  // Exposto pro gerador de PDF (script module no HTML), que vive fora deste IIFE.
  window.cotacaoPacoteAtual = function () {
    const { sub, discountVal, serviceVal, total } = calcTotais();
    return { itens: itensSelecionados(), count: totalItems(), sub, discountVal, serviceVal, total };
  };

  function buildWhatsAppMessage() {
    const lines = ['*Cotação de Pacote — Javari StrEat Park*', ''];
    let sub = 0;

    for (const k in cart) {
      if (cart[k] <= 0) continue;
      const [ci, ii] = k.split(':').map(Number);
      const item = menu[ci]?.items[ii];
      if (!item || !item.price) continue;
      const lineTotal = item.price * cart[k];
      sub += lineTotal;
      lines.push('• ' + cart[k] + 'x ' + item.name + ' — ' + formatBRL(lineTotal));
    }

    const discountVal = sub * DISCOUNT;
    const afterDiscount = sub - discountVal;
    const serviceVal = afterDiscount * SERVICE;
    const total = afterDiscount + serviceVal;

    lines.push('');
    lines.push('Subtotal: ' + formatBRL(sub));
    lines.push('Desconto pacote (5%): -' + formatBRL(discountVal));
    lines.push('Serviço (10%): +' + formatBRL(serviceVal));
    lines.push('*Total estimado: ' + formatBRL(total) + '*');
    lines.push('');
    lines.push('Gostaria de fechar esse pacote ou negociar condições melhores!');

    return lines.join('\n');
  }

  function openModal() {
    $modalList.innerHTML = '';
    let sub = 0;

    const entries = [];
    for (const k in cart) {
      if (cart[k] <= 0) continue;
      const [ci, ii] = k.split(':').map(Number);
      const item = menu[ci]?.items[ii];
      if (!item || !item.price) continue;
      entries.push({ item, qty: cart[k], catName: menu[ci].category });
    }

    entries.forEach(({ item, qty }) => {
      const lineTotal = item.price * qty;
      sub += lineTotal;
      const row = document.createElement('div');
      row.className = 'modal-item';
      row.innerHTML =
        '<span class="modal-item-name">' + item.name + '</span>' +
        '<span class="modal-item-qty">' + qty + 'x</span>' +
        '<span class="modal-item-price">' + formatBRL(lineTotal) + '</span>';
      $modalList.appendChild(row);
    });

    const { discountVal, serviceVal, total } = calcTotais();

    $modalSubtotal.textContent = formatBRL(sub);
    $modalDiscountVal.textContent = '- ' + formatBRL(discountVal);
    $modalServiceVal.textContent = '+ ' + formatBRL(serviceVal);
    $modalFinal.textContent = formatBRL(total);

    const msg = buildWhatsAppMessage();
    $modalSend.href = 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(msg);

    $modal.classList.remove('hidden');
    requestAnimationFrame(() => $modal.classList.add('visible'));
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $modal.classList.remove('visible');
    document.body.style.overflow = '';
    setTimeout(() => $modal.classList.add('hidden'), 300);
  }

  $barCTA.addEventListener('click', openModal);
  $modalClose.addEventListener('click', closeModal);
  $modalBackdrop.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $modal.classList.contains('visible')) closeModal();
  });

  function updateArrows() {
    if (!$arrowLeft || !$arrowRight) return;
    const scrollLeft = $catTabs.scrollLeft;
    const maxScroll = $catTabs.scrollWidth - $catTabs.clientWidth;
    $arrowLeft.classList.toggle('hidden-arrow', scrollLeft <= 4);
    $arrowRight.classList.toggle('hidden-arrow', scrollLeft >= maxScroll - 4);
  }

  if ($arrowLeft && $arrowRight) {
    $arrowLeft.addEventListener('click', () => {
      $catTabs.scrollBy({ left: -200, behavior: 'smooth' });
    });
    $arrowRight.addEventListener('click', () => {
      $catTabs.scrollBy({ left: 200, behavior: 'smooth' });
    });
    $catTabs.addEventListener('scroll', updateArrows);
    window.addEventListener('resize', updateArrows);
  }

  // Espelha o cardápio PÚBLICO do menudino (javaripark.menudino.com), que é a curadoria
  // oficial da casa. O cardapio.json é o dump CRU do Consumer POS (350 itens, inclui coisas
  // internas: BRINDES de R$0,01, PORTARIA, SERVIÇO...). O POS alimenta o menudino, então os
  // PREÇOS já batem — só precisamos esconder o que o menudino esconde e usar a mesma ordem.
  const ORDEM_MENUDINO = ['CERVEJAS', 'DRINKS PRONTOS', 'CAIPIRINHA', 'GIN', 'DRINKS CLÁSSICOS',
    'DOSES E GARRAFAS', 'CACHAÇAS', 'VINHOS E ESPUMANTES', 'NÃO ALCOÓLICOS', 'PORÇÕES',
    'BAGUETES', 'SOBREMESAS', 'FEIJOADA'];
  // Categorias operacionais/internas que o menudino NÃO exibe (e não cabem num pacote pré-pago).
  const OCULTAR = new Set(['BRINDES', 'COMPLEMENTO', 'FESTA JUNINA', 'OUTROS', 'PORTARIA', 'SERVIÇO', 'SERVICO']);
  const normCat = s => (s || '').trim().toUpperCase();

  fetch('data/cardapio.json')
    .then(r => r.json())
    .then(data => {
      menu = (data.categories || [])
        .filter(c => !OCULTAR.has(normCat(c.category)))
        // Derruba itens < R$1 (SKUs de brinde/cortesia perdidos em categorias boas).
        .map(c => ({ ...c, items: c.items.filter(i => i.price != null && i.price >= 1) }))
        .filter(c => c.items.length > 0)
        // Ordem do menudino; categoria nova que ainda não mapeamos vai pro fim (não some).
        .sort((a, b) => {
          const ia = ORDEM_MENUDINO.indexOf(normCat(a.category));
          const ib = ORDEM_MENUDINO.indexOf(normCat(b.category));
          return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
        });
      if (menu.length === 0) {
        $grid.innerHTML = '<div class="items-loading">Cardápio indisponível no momento.</div>';
        return;
      }
      renderTabs();
      renderItems();
      requestAnimationFrame(updateArrows);
    })
    .catch(() => {
      $grid.innerHTML = '<div class="items-loading">Erro ao carregar o cardápio. Tente novamente.</div>';
    });
})();
