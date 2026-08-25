[DEPLOIEMENT.md](https://github.com/user-attachments/files/31414937/DEPLOIEMENT.md)
# Déploiement v0.8

Architecture conseillée :
- Frontend statique : Cloudflare Pages / Netlify
- API Node.js : Render / Railway / Fly.io / VPS
- PostgreSQL managé
- Domaine personnalisé
- HTTPS

Variables serveur :
- DATABASE_URL
- JWT_SECRET
- CLIENT_ORIGIN
- COOKIE_SECURE=true
- NODE_ENV=production

Le Gold réel ne doit jamais être crédité depuis le navigateur. Un paiement futur doit passer par un webhook signé du prestataire de paiement puis par une transaction PostgreSQL.
