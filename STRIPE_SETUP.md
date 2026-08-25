# Configuration Stripe

## 1. Créer votre compte Stripe
Créez / validez votre compte marchand Stripe.

## 2. Récupérer les clés
Dans les variables d'environnement du serveur :

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CURRENCY=eur
PUBLIC_APP_URL=https://votre-site.fr

Ne mettez jamais `STRIPE_SECRET_KEY` dans le frontend ou GitHub.

## 3. Configurer le webhook
URL :
https://VOTRE_API/api/payments/stripe/webhook

Événement :
checkout.session.completed

Copiez ensuite le secret `whsec_...` dans `STRIPE_WEBHOOK_SECRET`.

## 4. Tester
Lancez d'abord Stripe en mode test.
Vérifiez :
- paiement réussi
- paiement annulé
- webhook reçu
- Gold crédité une seule fois
- rafraîchissement de page sans double crédit
- webhook rejoué sans double crédit
- mauvais montant rejeté

## 5. Production
Passez en clés live uniquement lorsque :
- le site est en HTTPS
- la société / activité est correctement déclarée
- vos CGV et politique de confidentialité sont accessibles
- les règles de remboursement sont définies
- la fiscalité et la comptabilité des ventes sont organisées
