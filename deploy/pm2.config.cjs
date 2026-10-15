// cms-api under pm2 on the live server (deploy/README.md, step 3): `pm2 start deploy/pm2.config.cjs`
// in this repo, after `npm run build` (or `npm run db:migrate`, which builds). The API reads its
// settings from .env in this repo.
module.exports = {
  apps: [
    {
      name: 'nodepress-api',
      cwd: `${__dirname}/..`,
      script: 'dist/main.js',
      env: { NODE_ENV: 'production' },
    },
  ],
};
