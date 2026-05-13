(function () {
  'use strict';

  const WHATSAPP_NUMBER = '551120811544';
  const DISCOUNT = 0.05;

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
  const $barOriginal = document.getElementById('barOriginal');
  const $barFinal = document.getElementById('barFinal');
  const $barCTA = document.getElementById('barCTA');
  const $modal = document.getElementById('reviewModal');
  const $modalList = document.getElementById('modalList');
  const $modalSubtotal = document.getElementById('modalSubtotal');
  const $modalDiscountVal = document.getElementById('modalDiscountVal');
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

  function updateBar() {
    const count = totalItems();
    const sub = subtotal();
    const discountVal = sub * DISCOUNT;
    const final_ = sub - discountVal;

    $barItems.textContent = count + (count === 1 ? ' item' : ' itens');
    $barOriginal.textContent = formatBRL(sub);
    $barFinal.textContent = formatBRL(final_);

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
        priceHTML = '<span class="item-price">' + item.priceFormatted + '</span>';
      } else {
        priceHTML = '<span class="item-price-variable">' + (item.priceFormatted || 'Consultar') + '</span>';
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
    const final_ = sub - discountVal;

    lines.push('');
    lines.push('Subtotal: ' + formatBRL(sub));
    lines.push('Desconto pacote (5%): -' + formatBRL(discountVal));
    lines.push('*Total estimado: ' + formatBRL(final_) + '*');
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

    const discountVal = sub * DISCOUNT;
    const final_ = sub - discountVal;

    $modalSubtotal.textContent = formatBRL(sub);
    $modalDiscountVal.textContent = '- ' + formatBRL(discountVal);
    $modalFinal.textContent = formatBRL(final_);

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

  fetch('data/cardapio.json')
    .then(r => r.json())
    .then(data => {
      menu = (data.categories || []).filter(c =>
        c.items.some(i => i.price !== null && i.price > 0)
      );
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
