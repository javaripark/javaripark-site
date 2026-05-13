# Javari StrEat Park

Site público + admin interno do Javari StrEat Park (Mooca, SP).

## Estrutura

```
javari-park/
├── public/         # site público (HTML/CSS/JS estático)
├── admin/          # painel interno (futuro)
├── functions/      # Cloud Functions (futuro)
├── docs/           # documentação técnica
├── firebase.json   # config Firebase Hosting + Firestore
├── firestore.rules
└── firestore.indexes.json
```

## Rodar localmente

Servidor estático simples:
```bash
cd public && python3 -m http.server 8000
```
Abrir http://localhost:8000

Ou via Firebase CLI (depois de configurar o projeto):
```bash
firebase serve
```

## Deploy

```bash
firebase deploy --only hosting
```

## Stack

- HTML/CSS/JS vanilla (zero build step)
- Firebase Hosting (CDN, HTTPS)
- Firestore (banco de dados)
- Firebase Auth (admin)
- Cloud Functions (lógica server-side)

## Roadmap

- [ ] Site público (em andamento)
- [ ] Admin: reserva de mesas
- [ ] Admin: convites personalizados
- [ ] Admin: cotações
- [ ] Admin: gestão de estoque
- [ ] Admin: gestão financeira
