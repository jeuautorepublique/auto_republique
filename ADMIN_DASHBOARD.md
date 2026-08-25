# Tableau de bord administrateur

Endpoint :
GET /api/admin/world/:worldId/dashboard

Header :
x-admin-key: ADMIN_API_KEY

Simulation :
POST /api/admin/world/:worldId/simulate
Body :
{"days":30}
ou 90 / 365

La simulation est analytique et non destructive.
