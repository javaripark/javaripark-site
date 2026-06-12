// Religa os listeners em tempo real (onSnapshot) quando a aba volta de sleep ou
// de queda de rede. Sem isso, fechar o Mac (ou trocar de Wi-Fi/4G) e reabrir
// deixava o painel "preso" mostrando dados velhos — o WebChannel do Firestore
// demora a religar sozinho. Forçar disableNetwork→enableNetwork entrega o estado
// fresco do servidor a TODOS os onSnapshot ativos na hora.
//
// Inclua junto com change-password.js:
//   <script type="module" src="/js/realtime-resilience.js"></script>
import { getApp, getApps } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getFirestore, disableNetwork, enableNetwork } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

let religando = false;
async function religar() {
  if (religando || !getApps().length) return;
  religando = true;
  try {
    const db = getFirestore(getApp()); // mesma instância que a página já usa
    await disableNetwork(db);
    await enableNetwork(db);            // re-entrega o estado atual aos listeners
  } catch (e) {
    /* silencioso: religa de novo no próximo evento */
  } finally {
    religando = false;
  }
}

// Só força refresh se ficou escondido por mais de 10s (sleep / troca de app),
// pra não toggar a rede a cada troca rápida de aba.
let escondidoEm = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { escondidoEm = Date.now(); return; }
  if (Date.now() - escondidoEm > 10000) religar();
});
window.addEventListener('online', religar);
