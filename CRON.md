[CRON.md](https://github.com/user-attachments/files/31414902/CRON.md)
# Mise à jour automatique à minuit

La route de tick est maintenant protégée par `CRON_SECRET`.

Endpoint :
POST `/api/cron/world/beta/daily-tick`
POST `/api/cron/world/world1/daily-tick`

Header obligatoire :
`x-cron-secret: <CRON_SECRET>`

En production, configurez deux tâches cron à 00:00 Europe/Paris.
Le serveur refuse les doubles ticks le même jour.
