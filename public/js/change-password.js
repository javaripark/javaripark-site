// Botão "Senha" + modal de troca de senha, reutilizável em todas as páginas admin.
// Inclua com: <script type="module" src="/js/change-password.js"></script>
// Usa Firebase Auth (app dedicado 'changepw' — pega a sessão logada via IndexedDB).
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, onAuthStateChanged, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";

const CFG = { apiKey: "AIzaSyBPsAFkMBXtmlv6UvavXGdD86nWz9b__18", authDomain: "central-de-reservas-jsp.firebaseapp.com", projectId: "central-de-reservas-jsp", storageBucket: "central-de-reservas-jsp.firebasestorage.app", appId: "1:574859111927:web:83df67ed1865a59c0392f2" };
// Reusa o app DEFAULT da página (mesma sessão Firebase no IndexedDB); só cria se a página não tiver inicializado.
const app = getApps().find(a => a.name === '[DEFAULT]') || initializeApp(CFG);
const auth = getAuth(app);

function montar(user) {
  if (document.getElementById('senhaBtn')) return; // já montado
  const logout = document.getElementById('logoutBtn');
  if (!logout) return;

  // Botão "Senha" ao lado de "Sair", herdando o estilo do logout
  const btn = document.createElement('button');
  btn.id = 'senhaBtn';
  btn.className = logout.className;
  btn.textContent = 'Senha';
  logout.parentNode.insertBefore(btn, logout);
  // posiciona à esquerda do "Sair" (headers usam logout absoluto à direita)
  const cs = getComputedStyle(logout);
  if (cs.position === 'absolute') {
    btn.style.position = 'absolute';
    btn.style.top = cs.top; btn.style.transform = cs.transform;
    btn.style.right = (logout.offsetWidth + 24) + 'px';
  } else {
    btn.style.marginRight = '8px';
  }

  // Modal
  const wrap = document.createElement('div');
  wrap.id = 'senha-modal';
  wrap.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;align-items:center;justify-content:center;padding:18px';
  wrap.innerHTML = `
    <div style="background:#fff;border-radius:14px;max-width:380px;width:100%;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.3);font-family:inherit">
      <h3 style="font-size:16px;font-weight:700;margin:0 0 14px;color:#4f1964">Trocar senha</h3>
      <label style="display:block;font-size:12px;font-weight:600;color:#666;margin-bottom:5px">Senha atual</label>
      <input id="s-atual" type="password" autocomplete="current-password" style="width:100%;padding:10px 12px;border:1px solid #dcdce2;border-radius:9px;font-size:14px;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;font-size:12px;font-weight:600;color:#666;margin-bottom:5px">Nova senha (mín. 8 caracteres)</label>
      <input id="s-nova" type="password" autocomplete="new-password" style="width:100%;padding:10px 12px;border:1px solid #dcdce2;border-radius:9px;font-size:14px;margin-bottom:12px;box-sizing:border-box">
      <label style="display:block;font-size:12px;font-weight:600;color:#666;margin-bottom:5px">Confirmar nova senha</label>
      <input id="s-conf" type="password" autocomplete="new-password" style="width:100%;padding:10px 12px;border:1px solid #dcdce2;border-radius:9px;font-size:14px;margin-bottom:8px;box-sizing:border-box">
      <p id="s-msg" style="font-size:13px;min-height:18px;margin:0 0 12px"></p>
      <div style="display:flex;flex-direction:column;gap:9px">
        <button id="s-salvar" style="padding:11px;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;background:#4f1964;color:#fff">Salvar nova senha</button>
        <button id="s-fechar" style="padding:8px;border:none;border-radius:9px;font-size:13px;cursor:pointer;background:none;color:#999">Cancelar</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const g = id => document.getElementById(id);
  const setMsg = (t, erro) => { g('s-msg').textContent = t; g('s-msg').style.color = erro ? '#ef4444' : '#16a34a'; };
  btn.onclick = () => { ['s-atual', 's-nova', 's-conf'].forEach(id => g(id).value = ''); setMsg(''); wrap.style.display = 'flex'; g('s-atual').focus(); };
  g('s-fechar').onclick = () => { wrap.style.display = 'none'; };
  wrap.onclick = e => { if (e.target === wrap) wrap.style.display = 'none'; };
  g('s-salvar').onclick = async () => {
    const atual = g('s-atual').value, nova = g('s-nova').value, conf = g('s-conf').value;
    if (!atual || !nova) return setMsg('Preencha a senha atual e a nova.', true);
    if (nova.length < 8) return setMsg('A nova senha precisa de ao menos 8 caracteres.', true);
    if (nova !== conf) return setMsg('A confirmação não bate com a nova senha.', true);
    if (nova === atual) return setMsg('A nova senha é igual à atual.', true);
    g('s-salvar').disabled = true; setMsg('Trocando…');
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, atual));
      await updatePassword(user, nova);
      setMsg('Senha trocada com sucesso! ✓');
      setTimeout(() => { wrap.style.display = 'none'; }, 1500);
    } catch (e) {
      const m = String(e.code || e.message || '');
      if (m.includes('wrong-password') || m.includes('invalid-credential')) setMsg('Senha atual incorreta.', true);
      else if (m.includes('too-many-requests')) setMsg('Muitas tentativas — espere um pouco e tente de novo.', true);
      else if (m.includes('weak-password')) setMsg('Senha muito fraca.', true);
      else setMsg('Não consegui trocar: ' + m, true);
    } finally { g('s-salvar').disabled = false; }
  };
}

onAuthStateChanged(auth, user => { if (user) montar(user); });
