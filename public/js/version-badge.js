// Selo de versão — mostra commit + data do deploy atual (gerado pelo workflow).
// Serve pra confirmar que todos estão vendo a MESMA versão do sistema.
(function () {
  fetch('/version.json?v=' + Date.now())
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (v) {
      var label = v
        ? 'v' + (v.commit || '?') + ' · ' + (v.builtAt ? fmt(v.builtAt) : '')
        : 'versão local';
      var el = document.createElement('div');
      el.id = 'version-badge';
      el.textContent = label;
      el.title = 'Versão do sistema no ar' + (v && v.builtAt ? ' (deploy em ' + v.builtAt + ')' : '');
      el.style.cssText = [
        'position:fixed', 'bottom:8px', 'right:8px', 'z-index:9998',
        'background:rgba(26,26,26,.78)', 'color:#cbb6db', 'font:600 10px/1.4 Inter,system-ui,sans-serif',
        'padding:3px 8px', 'border-radius:8px', 'letter-spacing:.3px',
        'pointer-events:auto', 'cursor:default', 'user-select:all', 'opacity:.75'
      ].join(';');
      document.body.appendChild(el);
    })
    .catch(function () {});

  function fmt(iso) {
    try {
      var d = new Date(iso);
      var p = function (n) { return String(n).padStart(2, '0'); };
      return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return iso; }
  }
})();
