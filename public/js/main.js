// Javari StrEat Park — main.js
// Lenis + GSAP. Hero cinematografico com pin + scrub.

(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ===== Footer year =====
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ===== Mobile nav toggle =====
  const navToggle = document.getElementById('nav-toggle');
  const siteNav = document.querySelector('.site-nav');
  if (navToggle && siteNav) {
    navToggle.addEventListener('click', () => {
      const open = siteNav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', open);
    });
    siteNav.querySelectorAll('a:not(.nav-dropdown-toggle)').forEach(a => {
      a.addEventListener('click', () => {
        siteNav.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  document.querySelectorAll('.nav-dropdown-toggle').forEach(toggle => {
    toggle.addEventListener('click', e => {
      e.preventDefault();
      toggle.closest('.nav-dropdown').classList.toggle('open');
    });
  });

  // ===== Bottom nav: highlight active section =====
  const bottomNav = document.querySelector('.bottom-nav');
  if (bottomNav) {
    const sections = ['hero', 'cardapio', 'agenda', 'localizacao', 'reservas'];
    const links = bottomNav.querySelectorAll('.bottom-nav-link');

    const updateActive = () => {
      const y = window.scrollY + window.innerHeight / 2;
      let current = '';
      for (const id of sections) {
        const el = document.getElementById(id);
        if (el && el.offsetTop <= y) current = id;
      }
      links.forEach(link => {
        const href = link.getAttribute('href')?.replace('#', '');
        link.classList.toggle('active', href === current);
      });
    };

    window.addEventListener('scroll', updateActive, { passive: true });
    updateActive();

    // Hide bottom nav when near footer
    const footer = document.querySelector('.site-footer');
    if (footer) {
      const hideNearFooter = () => {
        const footerTop = footer.getBoundingClientRect().top;
        bottomNav.classList.toggle('hidden', footerTop < window.innerHeight);
      };
      window.addEventListener('scroll', hideNearFooter, { passive: true });
      hideNearFooter();
    }
  }

  // ===== Map overlay: block scroll-zoom until click =====
  const mapOverlay = document.getElementById('map-overlay');
  if (mapOverlay) {
    mapOverlay.addEventListener('click', () => {
      mapOverlay.classList.add('active');
    });
    document.addEventListener('scroll', () => {
      mapOverlay.classList.remove('active');
    }, { passive: true });
  }

  // ===== Lenis smooth scroll =====
  let lenis = null;
  if (!reduceMotion && typeof Lenis !== 'undefined') {
    lenis = new Lenis({
      duration: 0.8,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      lerp: 0.18,
    });

    function raf(time) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);

    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('href');
        if (id === '#' || id.length < 2) return;
        const target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        lenis.scrollTo(target, { offset: -80, duration: 1.4 });
      });
    });
  }

  // ===== Header scroll state =====
  const header = document.getElementById('header');
  if (header) {
    const heroEl = document.getElementById('hero');
    let heroH = heroEl ? heroEl.offsetHeight : 0;
    window.addEventListener('resize', () => { heroH = heroEl ? heroEl.offsetHeight : 0; }, { passive: true });
    const onScroll = () => {
      const y = window.scrollY;
      if (y > 40) {
        header.classList.add('scrolled');
        if (y > heroH - 80) header.classList.add('light-section');
        else header.classList.remove('light-section');
      } else {
        header.classList.remove('scrolled', 'light-section');
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ===== Bus gallery drag with inertia =====
  const busGallery = document.getElementById('bus-gallery');
  if (busGallery) {
    let isDown = false, startX, scrollLeft, velocity = 0, lastX, lastTime, animId;

    busGallery.addEventListener('mousedown', (e) => {
      isDown = true;
      busGallery.style.cursor = 'grabbing';
      startX = e.pageX - busGallery.offsetLeft;
      scrollLeft = busGallery.scrollLeft;
      velocity = 0;
      lastX = e.pageX;
      lastTime = Date.now();
      cancelAnimationFrame(animId);
    });

    busGallery.addEventListener('mouseleave', () => { if (isDown) release(); });
    busGallery.addEventListener('mouseup', release);

    busGallery.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - busGallery.offsetLeft;
      const walk = (x - startX) * 1.5;
      busGallery.scrollLeft = scrollLeft - walk;

      const now = Date.now();
      const dt = now - lastTime;
      if (dt > 0) {
        velocity = (e.pageX - lastX) / dt;
        lastX = e.pageX;
        lastTime = now;
      }
    });

    function release() {
      if (!isDown) return;
      isDown = false;
      busGallery.style.cursor = 'grab';
      inertia();
    }

    function inertia() {
      if (Math.abs(velocity) < 0.01) return;
      busGallery.scrollLeft -= velocity * 16;
      velocity *= 0.94;
      animId = requestAnimationFrame(inertia);
    }
  }

  // ===== GSAP + ScrollTrigger =====
  if (!reduceMotion && typeof gsap !== 'undefined') {
    if (typeof ScrollTrigger !== 'undefined') {
      gsap.registerPlugin(ScrollTrigger);
      if (lenis) {
        lenis.on('scroll', ScrollTrigger.update);
        gsap.ticker.add((time) => lenis.raf(time * 1000));
        gsap.ticker.lagSmoothing(0);
      }
    }

    // Safe gsap.from wrapper — guarantees elements become visible even if trigger fails
    const safeFrom = (targets, vars) => {
      const tween = gsap.from(targets, vars);
      setTimeout(() => {
        const els = typeof targets === 'string'
          ? document.querySelectorAll(targets)
          : (targets.length !== undefined ? targets : [targets]);
        els.forEach(el => {
          if (el && getComputedStyle(el).opacity === '0') {
            gsap.set(el, { opacity: 1, y: 0, x: 0, scale: 1, clearProps: 'all' });
          }
        });
      }, 4000);
      return tween;
    };

    // -- Hero entrance: title words stagger --
    const heroWords = document.querySelectorAll('.hero-title .word');
    if (heroWords.length) {
      gsap.from(heroWords, {
        y: 80, opacity: 0, rotateX: 20,
        duration: 1.1, stagger: 0.07, ease: 'power3.out', delay: 0.4,
      });
    }
    gsap.from('.hero-eyebrow', { y: 20, opacity: 0, duration: 0.8, ease: 'power2.out', delay: 1.0 });
    gsap.from('.hero-tagline', { y: 20, opacity: 0, duration: 0.8, ease: 'power2.out', delay: 1.2 });
    gsap.from('.hero-actions', { y: 20, opacity: 0, duration: 0.8, ease: 'power2.out', delay: 1.4 });

    if (typeof ScrollTrigger !== 'undefined') {
      const heroPhoto = document.querySelector('.hero-photo img');
      const heroOverlay = document.getElementById('hero-overlay');
      const heroContent = document.getElementById('hero-content');

      if (heroPhoto && heroOverlay && heroContent) {
        gsap.to(heroPhoto, {
          scale: 1.12,
          ease: 'none',
          scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: 'bottom top',
            scrub: true,
          },
        });

        gsap.to(heroContent, {
          y: -100,
          opacity: 0,
          ease: 'none',
          scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: '60% top',
            scrub: true,
          },
        });
      }

      const st = (trigger, start) => ({
        trigger,
        start: start || 'top bottom-=40',
        toggleActions: 'play none none none',
        once: true,
      });

      safeFrom('.manifesto-title', {
        scrollTrigger: st('.manifesto', 'top 80%'),
        y: 50, opacity: 0, duration: 1.1, ease: 'power3.out',
      });

      gsap.utils.toArray('.pillar').forEach((el, i) => {
        safeFrom(el, {
          scrollTrigger: st(el),
          y: 60 + i * 15, opacity: 0, duration: 0.9, delay: i * 0.12, ease: 'power3.out',
        });

        gsap.to(el.querySelector('.pillar-img img'), {
          scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true },
          y: -15, ease: 'none',
        });
      });

      safeFrom('.bus-title .word', {
        scrollTrigger: st('.bus-lounge', 'top 80%'),
        y: 80, opacity: 0, duration: 1.1, stagger: 0.15, ease: 'power3.out',
      });
      safeFrom('.bus-lead', {
        scrollTrigger: st('.bus-lounge', 'top 75%'),
        y: 30, opacity: 0, duration: 0.9, ease: 'power2.out',
      });

      safeFrom('.bus-slide', {
        scrollTrigger: st('.bus-gallery'),
        x: 100, opacity: 0, duration: 1, stagger: 0.12, ease: 'power3.out',
      });

      const busBg = document.querySelector('.bus-bg img');
      if (busBg) {
        gsap.fromTo(busBg, { x: '0%' }, {
          x: '-12%',
          ease: 'none',
          scrollTrigger: {
            trigger: '.bus-lounge',
            start: 'top bottom',
            end: 'bottom top',
            scrub: true,
          },
        });
      }

      safeFrom('.cardapio-title, .cardapio-lead', {
        scrollTrigger: st('.cardapio', 'top 85%'),
        y: 40, opacity: 0, duration: 0.9, stagger: 0.12, ease: 'power3.out',
      });
      gsap.utils.toArray('.card-item').forEach((el, i) => {
        safeFrom(el, {
          scrollTrigger: st(el),
          y: 50, opacity: 0, duration: 0.8, delay: i * 0.08, ease: 'power3.out',
        });
      });
      safeFrom('.cardapio-cta', {
        scrollTrigger: st('.cardapio-cta'),
        y: 30, opacity: 0, duration: 0.8, ease: 'power2.out',
      });

      gsap.utils.toArray('.agenda-item').forEach((el, i) => {
        safeFrom(el, {
          scrollTrigger: st(el),
          x: -40, opacity: 0, duration: 0.7, delay: i * 0.06, ease: 'power2.out',
        });
      });

      safeFrom('.galeria-title', {
        scrollTrigger: st('.galeria', 'top 85%'),
        y: 40, opacity: 0, duration: 1, ease: 'power3.out',
      });
      gsap.utils.toArray('.mosaic-item').forEach((el, i) => {
        safeFrom(el, {
          scrollTrigger: st(el),
          y: 40, opacity: 0, scale: .95, duration: 0.8, delay: i * 0.06, ease: 'power3.out',
        });
      });
      safeFrom('.galeria-foot', {
        scrollTrigger: st('.galeria-foot'),
        y: 30, opacity: 0, duration: 0.8, ease: 'power2.out',
      });

      safeFrom('.depoimentos-title', {
        scrollTrigger: st('.depoimentos', 'top 80%'),
        y: 50, opacity: 0, duration: 1.1, ease: 'power3.out',
      });
      gsap.utils.toArray('.depo-card').forEach((el, i) => {
        safeFrom(el, {
          scrollTrigger: st(el),
          y: 50, opacity: 0, duration: 0.8, delay: i * 0.12, ease: 'power3.out',
        });
      });
      safeFrom('.depoimentos-foot', {
        scrollTrigger: st('.depoimentos-foot'),
        y: 30, opacity: 0, duration: 0.9, ease: 'power2.out',
      });

      safeFrom('.localizacao-title, .localizacao-lead', {
        scrollTrigger: st('.localizacao', 'top 80%'),
        y: 40, opacity: 0, duration: 1, stagger: 0.1, ease: 'power3.out',
      });
      safeFrom('.map-wrap', {
        scrollTrigger: st('.map-wrap', 'top 85%'),
        y: 40, opacity: 0, duration: 1, ease: 'power3.out',
      });
      safeFrom('.localizacao-actions .btn', {
        scrollTrigger: st('.localizacao-actions'),
        y: 30, opacity: 0, duration: 0.8, stagger: 0.1, ease: 'power2.out',
      });

      const reservasPhotoEl = document.querySelector('.reservas-photo');
      const reservasPhotoImg = document.querySelector('.reservas-photo img');
      if (reservasPhotoEl) {
        gsap.fromTo(reservasPhotoEl,
          { clipPath: 'inset(20% 35% 20% 35%)' },
          {
            clipPath: 'inset(0% 0% 0% 0%)',
            ease: 'power2.out',
            scrollTrigger: {
              trigger: '.reservas',
              start: 'top 90%',
              end: 'top 30%',
              scrub: true,
            },
          }
        );
      }
      if (reservasPhotoImg) {
        gsap.fromTo(reservasPhotoImg,
          { scale: 1.18 },
          {
            scale: 1.0,
            ease: 'none',
            scrollTrigger: {
              trigger: '.reservas',
              start: 'top bottom',
              end: 'bottom top',
              scrub: true,
            },
          }
        );
      }

      safeFrom('.reservas-title', {
        scrollTrigger: st('.reservas', 'top 80%'),
        y: 60, opacity: 0, duration: 1.1, ease: 'power3.out',
      });
      safeFrom('.reservas .btn, .reservas-phone', {
        scrollTrigger: st('.reservas', 'top 75%'),
        y: 30, opacity: 0, duration: 0.9, stagger: 0.15, ease: 'power2.out',
      });

      safeFrom('.footer-brand, .footer-block', {
        scrollTrigger: st('.site-footer'),
        y: 30, opacity: 0, duration: 0.8, stagger: 0.1, ease: 'power2.out',
      });
    }
  }

  // ===== Magnetic buttons (desktop only) =====
  if (!reduceMotion && window.innerWidth > 880) {
    document.querySelectorAll('.magnetic').forEach(btn => {
      btn.addEventListener('mousemove', (e) => {
        const rect = btn.getBoundingClientRect();
        const x = e.clientX - rect.left - rect.width / 2;
        const y = e.clientY - rect.top - rect.height / 2;
        btn.style.transform = `translate(${x * 0.2}px, ${y * 0.2}px)`;
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = '';
      });
    });
  }
})();
