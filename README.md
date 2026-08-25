[README.md](https://github.com/user-attachments/files/31415137/README.md)
# Auto République v2.3 - Multijoueur

Cette version ajoute une vraie couche multijoueur partagée.

## Partagé côté serveur
- comptes
- euros
- Gold
- véhicules
- entreprises
- marché
- présence en ligne
- chat
- notifications
- événements du monde

## Temps réel
La connexion WebSocket utilise un ticket temporaire généré après authentification.
Le serveur diffuse les connexions, déconnexions et messages du monde.

## Tester à plusieurs
Lancez :
`docker compose -f docker-compose.multiplayer.yml up`

Puis ouvrez :
`http://localhost:8080`

Utilisez deux navigateurs ou une fenêtre privée avec deux comptes différents.

## Jouer depuis plusieurs téléphones / PC
Tous les joueurs doivent utiliser le même serveur Node.js et la même base PostgreSQL hébergés sur Internet.
Le ZIP seul ne peut pas fournir un monde multijoueur public permanent.
