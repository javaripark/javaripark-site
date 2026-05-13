#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const POSTS_JSON = path.join(__dirname, 'public/data/blog-posts.json');
const TEMPLATE = path.join(__dirname, 'public/blog/post.html');
const BLOG_DIR = path.join(__dirname, 'public/blog');

if (!fs.existsSync(POSTS_JSON)) {
  console.error('blog-posts.json not found. Run extraction first.');
  process.exit(1);
}

const posts = JSON.parse(fs.readFileSync(POSTS_JSON, 'utf8'));
const template = fs.readFileSync(TEMPLATE, 'utf8');

console.log(`Generating ${posts.length} blog post pages...`);

posts.forEach(post => {
  const dir = path.join(BLOG_DIR, post.slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const dateFormatted = new Date(post.date + 'T12:00:00').toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric'
  });

  const url = `https://javaripark.com.br/blog/${post.slug}`;
  const excerpt = (post.excerpt || '').replace(/"/g, '&quot;');
  const title = (post.title || '').replace(/"/g, '&quot;');

  const contentHTML = (post.content || '').split('\n\n').map(p => {
    p = p.trim();
    if (!p) return '';
    if (p.startsWith('###')) return `<h3>${p.replace(/^###\s*/, '')}</h3>`;
    if (p.startsWith('##')) return `<h2>${p.replace(/^##\s*/, '')}</h2>`;
    p = p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    return `<p>${p}</p>`;
  }).join('\n');

  const schema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": post.title,
    "image": post.featuredImage,
    "datePublished": post.date,
    "dateModified": post.date,
    "author": { "@type": "Person", "name": post.author || "René" },
    "publisher": {
      "@type": "Organization",
      "name": "Javari StrEat Park",
      "logo": { "@type": "ImageObject", "url": "https://javaripark.com.br/assets/images/logo-horizontal-black.png" }
    },
    "description": post.excerpt,
    "mainEntityOfPage": { "@type": "WebPage", "@id": url }
  });

  const encodedURL = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(post.title);

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#000000" />
  <title>${title} — Javari StrEat Park</title>
  <meta name="description" content="${excerpt}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${excerpt}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${post.featuredImage || ''}" />
  <meta property="og:site_name" content="Javari StrEat Park" />
  <meta property="og:locale" content="pt_BR" />
  <link rel="canonical" href="${url}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Poppins:wght@300;400;500;600;700&family=Sedgwick+Ave&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/css/style.css" />
  <link rel="stylesheet" href="/css/blog.css" />
  <script type="application/ld+json">${schema}</script>
</head>
<body>
  <header class="site-header site-header--inner" id="header">
    <a href="/" class="brand" aria-label="Javari StrEat Park">
      <img src="/assets/images/logo-horizontal-white.png" alt="Javari StrEat Park" class="brand-logo brand-logo--white" />
      <img src="/assets/images/logo-horizontal-black.png" alt="Javari StrEat Park" class="brand-logo brand-logo--black" />
    </a>
    <nav class="site-nav" aria-label="Navegação principal">
      <a href="/">Início</a>
      <a href="/#cardapio">Cardápio</a>
      <a href="/#agenda">Agenda</a>
      <a href="/#localizacao">Onde estamos</a>
      <a href="/regras">Regras</a>
      <a href="/blog">Blog</a>
      <div class="nav-dropdown">
        <a class="nav-dropdown-toggle" role="button" tabindex="0">Serviços <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 4.5L6 7.5L9 4.5"/></svg></a>
        <ul class="nav-dropdown-menu">
          <li><a href="/convite">Convite personalizado</a></li>
          <li><a href="/cotacao">Cotação de pacotes</a></li>
          <li><a href="/fotos">Cobertura fotográfica</a></li>
        </ul>
      </div>
      <a class="btn btn-primary magnetic" href="https://wa.me/+551120811544" target="_blank" rel="noopener">Reservar</a>
    </nav>
    <button class="nav-toggle" id="nav-toggle" aria-label="Menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </header>

  <main>
    <section class="post-hero">
      <div class="container">
        <div class="post-meta">${dateFormatted}</div>
        <h1 class="post-title">${post.title}</h1>
      </div>
    </section>

    ${post.featuredImage ? `<div class="post-featured"><img src="${post.featuredImage}" alt="${title}" /></div>` : ''}

    <article class="post-content">
      <a href="/blog" class="post-back">&larr; Voltar ao blog</a>
      ${contentHTML}

      <div class="post-share">
        <p class="post-share-label">Compartilhar</p>
        <div class="post-share-links">
          <a href="https://wa.me/?text=${encodedTitle}%20${encodedURL}" target="_blank" rel="noopener" title="WhatsApp">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
          </a>
          <a href="https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedURL}" target="_blank" rel="noopener" title="X">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </a>
          <a href="https://www.facebook.com/sharer/sharer.php?u=${encodedURL}" target="_blank" rel="noopener" title="Facebook">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
          </a>
        </div>
      </div>
    </article>

    <section class="post-cta">
      <div class="container">
        <h2 class="post-cta-title">Bora pro quintal?</h2>
        <p class="post-cta-sub">Reserve sua mesa e venha curtir o melhor da Mooca.</p>
        <a class="btn btn-xl" href="https://wa.me/+551120811544" target="_blank" rel="noopener">Reserve pelo WhatsApp</a>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container footer-grid">
      <div class="footer-brand">
        <img src="/assets/images/logo-horizontal-white.png" alt="Javari StrEat Park" class="footer-logo" />
        <p class="footer-tagline">SÓ VEM!</p>
      </div>
      <div class="footer-block">
        <h4>Endereço</h4>
        <p>Rua Javari, 112<br>Mooca · São Paulo</p>
        <a class="link-underline" href="/#localizacao">Ver no mapa</a>
      </div>
      <div class="footer-block">
        <h4>Contato</h4>
        <ul class="footer-links">
          <li><a href="https://wa.me/+551120811544" target="_blank" rel="noopener">WhatsApp · (11) 2081-1544</a></li>
          <li><a href="https://instagram.com/javaripark" target="_blank" rel="noopener">Instagram · @javaripark</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bar">
      <span>&copy; ${new Date().getFullYear()} Javari StrEat Park</span>
      <span class="footer-spacer">&middot;</span>
      <span>SÓ VEM!</span>
    </div>
  </footer>

  <script>
    const toggle = document.getElementById('nav-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const nav = document.querySelector('.site-nav');
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', !open);
        nav.classList.toggle('open');
      });
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  console.log(`  ✓ /blog/${post.slug}/`);
});

console.log(`\nDone! ${posts.length} pages generated.`);
