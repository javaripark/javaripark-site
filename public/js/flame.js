// Hero — partículas em violeta sobre a foto cinematográfica
// Sutil (mix-blend-mode: screen no CSS), pra dar atmosfera de noite/festa
(() => {
  const canvas = document.getElementById('flame-canvas');
  if (!canvas) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  let running = true, animId = 0;

  function resize() {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  const hero = canvas.closest('.hero') || canvas.parentElement;
  let heroBottom = hero ? hero.offsetTop + hero.offsetHeight : H;
  window.addEventListener('resize', () => {
    heroBottom = hero ? hero.offsetTop + hero.offsetHeight : H;
  }, { passive: true });

  function checkVisibility() {
    const visible = window.scrollY < heroBottom;
    if (visible && !running) {
      running = true;
      animId = requestAnimationFrame(frame);
    } else if (!visible && running) {
      running = false;
      cancelAnimationFrame(animId);
    }
  }
  window.addEventListener('scroll', checkVisibility, { passive: true });

  const particles = [];
  const MAX = 90;

  class Particle {
    constructor() { this.reset(); this.y = Math.random() * H; }
    reset() {
      this.x = Math.random() * W;
      this.y = H + Math.random() * 40;
      this.vx = (Math.random() - 0.5) * 0.25;
      this.vy = -0.3 - Math.random() * 0.9;
      this.life = 0;
      this.maxLife = 240 + Math.random() * 240;
      this.size = 1 + Math.random() * 2.4;
      this.hue = 255 + Math.random() * 30;
      this.sat = 70 + Math.random() * 25;
      this.light = 60 + Math.random() * 20;
    }
    step() {
      this.x += this.vx;
      this.y += this.vy;
      this.vx += (Math.random() - 0.5) * 0.025;
      this.vy -= 0.003;
      this.life++;
      if (this.life >= this.maxLife || this.y < -20) this.reset();
    }
    draw() {
      const t = this.life / this.maxLife;
      const alpha = Math.sin(t * Math.PI) * 0.55;
      const size = this.size * (1 + t * 0.5);
      ctx.beginPath();
      ctx.fillStyle = `hsla(${this.hue}, ${this.sat}%, ${this.light}%, ${alpha})`;
      ctx.arc(this.x, this.y, size + 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (let i = 0; i < MAX; i++) particles.push(new Particle());

  function frame() {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) { p.step(); p.draw(); }
    animId = requestAnimationFrame(frame);
  }
  frame();
})();
