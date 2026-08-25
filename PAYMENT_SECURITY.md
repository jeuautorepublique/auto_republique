# Sécurité paiements

- Stripe Checkout héberge la saisie des données de carte.
- Auto République ne stocke pas de numéro de carte.
- Le serveur valide la signature `Stripe-Signature`.
- Tolérance temporelle du webhook : 5 minutes.
- Chaque `provider_event_id` est unique.
- Chaque `provider_session_id` est unique.
- Le prix est vérifié contre PostgreSQL.
- La devise est vérifiée.
- Le produit est vérifié.
- Le portefeuille Gold est verrouillé pendant le crédit.
- Chaque crédit produit une écriture ledger.
- Les Gold ne sont jamais crédités à partir du callback navigateur.
