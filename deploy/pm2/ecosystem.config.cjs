module.exports = {
  apps: [
    {
      name: 'foodtestlab-api',
      script: './backend/server.js',
      cwd: '/opt/foodtestlab/current',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        SERVE_STATIC: 'false',
        CORS_ORIGIN: 'http://159.75.106.179:8081',
        JWT_EXPIRE: '7d'
      }
    }
  ]
}
