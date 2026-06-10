// Config do pm2 pro serviço de WhatsApp (lida com o espaço no caminho).
// Subir:  pm2 start ecosystem.config.cjs   ·   pm2 save
module.exports = {
  apps: [
    {
      name: 'javari-wa',
      script: 'src/server.js',
      cwd: '/Users/rene/Downloads/JAVARI PARK/wa-service',
      interpreter: 'node',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      time: true, // timestamp nos logs
    },
  ],
};
