# Sécurité v1.1

- Sessions HttpOnly
- Argon2id
- Rate limiting
- PostgreSQL transactions
- Permissions par rôle
- Clé admin séparée
- Secret cron séparé
- Achat et enchères exécutés côté serveur
- Verrouillage SQL sur les ressources critiques
- Journal d'audit
- Le navigateur n'est jamais la source de vérité pour argent, Gold ou propriété

Avant ouverture publique :
- utiliser HTTPS
- secrets uniquement en variables d'environnement
- PostgreSQL managé avec sauvegardes
- rotation des secrets
- monitoring
- reverse proxy
- limitation IP renforcée
- modération et signalements
