# Auto République v0.1

Prototype jouable d'un jeu communautaire de simulation automobile, économique et politique.

## Lancer le jeu
Ouvrez simplement `index.html` dans votre navigateur.

Le prototype fonctionne sans serveur et sauvegarde la partie dans le stockage local du navigateur.

## Modules présents
- Marché automobile
- Achat / réparation / vente
- Territoires
- Banque et crédit
- Politique
- Presse
- Justice
- Huissier / exécution simulée
- Progression par jours
- Sauvegarde locale

## Important
Cette v0.1 est un prototype local. Pour passer au vrai multijoueur persistant, la prochaine architecture devra inclure :
- serveur backend
- comptes joueurs
- base de données
- temps réel
- permissions par métier
- transactions atomiques
- historique d'audit
- système anti-fraude


## Ordinateur et téléphone
L'interface est responsive et s'adapte aux écrans mobiles.
Sur téléphone, une barre de navigation inférieure remplace le menu latéral.

Le projet contient également un manifeste PWA et un service worker.
Pour profiter de l'installation comme application et du mode hors-ligne, servez le dossier via un petit serveur web (HTTPS en production).


## Mondes

### Monde Bêta
- Sauvegarde indépendante
- 250 000 € de départ
- Réputation et progression de test
- Marché légèrement moins cher
- Fonctionnalités expérimentales
- Bouton de réinitialisation

### Monde 1
- Sauvegarde indépendante
- 250 000 € de départ
- Économie officielle
- Progression neuve
- Historique distinct du Monde Bêta

Le sélecteur de monde se trouve dans l'en-tête. Passer d'un monde à l'autre ne mélange jamais les véhicules, crédits, procédures, articles ou finances.


## Version Web PC + téléphone

Cette version est prête à être hébergée comme site web statique.

- PC : ouvrir l'URL dans Chrome, Edge, Firefox ou Safari.
- Android : ouvrir l'URL dans Chrome puis utiliser "Ajouter à l'écran d'accueil".
- iPhone : ouvrir l'URL dans Safari puis Partager > Ajouter à l'écran d'accueil.
- La journée du jeu est mise à jour automatiquement à minuit selon l'heure locale du joueur.
- Si le joueur revient après plusieurs jours, les mises à jour quotidiennes manquées sont appliquées.

### Mise en ligne
Déposez le contenu du ZIP sur un hébergeur statique compatible HTML/CSS/JS.


## Boutique Gold v0.6
100 Gold de bienvenue, packs fictifs et accélérateurs économiques. Aucun paiement réel dans ce prototype.
