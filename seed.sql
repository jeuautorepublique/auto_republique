
-- Véhicules système disponibles sur les deux mondes
INSERT INTO vehicles(world_id, owner_user_id, make, model, year, mileage, condition, estimated_value, status)
VALUES
('beta',NULL,'Peugeot','208',2019,76000,84,10400,'listed'),
('beta',NULL,'Renault','Clio V',2020,62000,89,11900,'listed'),
('beta',NULL,'Volkswagen','Golf VII',2018,108000,78,12700,'listed'),
('world1',NULL,'Peugeot','208',2019,76000,84,10400,'listed'),
('world1',NULL,'Renault','Clio V',2020,62000,89,11900,'listed'),
('world1',NULL,'Volkswagen','Golf VII',2018,108000,78,12700,'listed')
ON CONFLICT DO NOTHING;

INSERT INTO market_listings(world_id,vehicle_id,seller_user_id,price,status)
SELECT v.world_id,v.id,NULL,
  CASE v.model WHEN '208' THEN 9900 WHEN 'Clio V' THEN 11200 ELSE 12100 END,
  'active'
FROM vehicles v
LEFT JOIN market_listings ml ON ml.vehicle_id=v.id
WHERE v.owner_user_id IS NULL AND v.status='listed' AND ml.id IS NULL;


-- Entités publiques
INSERT INTO public_entities(world_id,entity_type,name,parent_id,treasury)
SELECT 'beta','country','France',NULL,1000000000
WHERE NOT EXISTS (SELECT 1 FROM public_entities WHERE world_id='beta' AND entity_type='country' AND name='France');

INSERT INTO public_entities(world_id,entity_type,name,parent_id,treasury)
SELECT 'world1','country','France',NULL,1000000000
WHERE NOT EXISTS (SELECT 1 FROM public_entities WHERE world_id='world1' AND entity_type='country' AND name='France');

INSERT INTO public_entities(world_id,entity_type,name,parent_id,treasury)
SELECT w,'region','Bourgogne-Franche-Comté',
       (SELECT id FROM public_entities WHERE world_id=w AND entity_type='country' AND name='France' LIMIT 1),
       18700000
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (
  SELECT 1 FROM public_entities pe WHERE pe.world_id=x.w AND pe.entity_type='region' AND pe.name='Bourgogne-Franche-Comté'
);

INSERT INTO public_entities(world_id,entity_type,name,parent_id,treasury)
SELECT w,'city','Dijon',
       (SELECT id FROM public_entities WHERE world_id=w AND entity_type='region' AND name='Bourgogne-Franche-Comté' LIMIT 1),
       2500000
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (
  SELECT 1 FROM public_entities pe WHERE pe.world_id=x.w AND pe.entity_type='city' AND pe.name='Dijon'
);

-- Banques publiques
INSERT INTO banks(world_id,bank_type,name,city,region,capital,base_rate)
SELECT w,'national','Banque Nationale',NULL,NULL,500000000,0.035
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (SELECT 1 FROM banks b WHERE b.world_id=x.w AND b.bank_type='national');

INSERT INTO banks(world_id,bank_type,name,city,region,capital,base_rate)
SELECT w,'regional','Banque Régionale BFC',NULL,'Bourgogne-Franche-Comté',50000000,0.028
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (SELECT 1 FROM banks b WHERE b.world_id=x.w AND b.bank_type='regional');

INSERT INTO banks(world_id,bank_type,name,city,region,capital,base_rate)
SELECT w,'municipal','Banque Municipale de Dijon','Dijon','Bourgogne-Franche-Comté',10000000,0.024
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (SELECT 1 FROM banks b WHERE b.world_id=x.w AND b.bank_type='municipal');

-- Flotte système étendue
INSERT INTO vehicles(world_id,owner_user_id,make,model,year,mileage,condition,estimated_value,status,
                     vehicle_type,fuel_type,seats,payload_kg,power_hp,purchase_price,rental_daily_price)
SELECT w,NULL,'Renault','Master',2020,134000,76,19500,'listed','van','diesel',3,1400,150,19500,95
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.world_id=x.w AND v.model='Master');

INSERT INTO vehicles(world_id,owner_user_id,make,model,year,mileage,condition,estimated_value,status,
                     vehicle_type,fuel_type,seats,payload_kg,power_hp,purchase_price,rental_daily_price)
SELECT w,NULL,'Volvo','FH 500',2019,612000,71,68000,'listed','truck','diesel',2,25000,500,68000,420
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.world_id=x.w AND v.model='FH 500');

INSERT INTO vehicles(world_id,owner_user_id,make,model,year,mileage,condition,estimated_value,status,
                     vehicle_type,fuel_type,seats,payload_kg,power_hp,purchase_price,rental_daily_price)
SELECT w,NULL,'Mercedes-Benz','Tourismo',2018,488000,74,92000,'listed','bus','diesel',55,0,394,92000,600
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.world_id=x.w AND v.model='Tourismo');

INSERT INTO vehicles(world_id,owner_user_id,make,model,year,mileage,condition,estimated_value,status,
                     vehicle_type,fuel_type,seats,payload_kg,power_hp,purchase_price,rental_daily_price)
SELECT w,NULL,'Tesla','Model 3',2022,48000,91,27900,'listed','car','electric',5,0,283,27900,120
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.world_id=x.w AND v.model='Model 3');

INSERT INTO market_listings(world_id,vehicle_id,seller_user_id,price,status)
SELECT v.world_id,v.id,NULL,
  CASE v.vehicle_type
    WHEN 'truck' THEN 65000
    WHEN 'bus' THEN 88000
    WHEN 'van' THEN 18500
    ELSE 26500
  END,'active'
FROM vehicles v
LEFT JOIN market_listings ml ON ml.vehicle_id=v.id
WHERE v.owner_user_id IS NULL AND v.status='listed' AND ml.id IS NULL;


INSERT INTO parts_catalog(sku,name,category,base_value,unit_weight_kg) VALUES
('AR-ENG-I4','Moteur 4 cylindres','engine',3500,145),
('AR-ENG-V6','Moteur V6','engine',6900,210),
('AR-BAT-60','Batterie 60 kWh','battery',6500,420),
('AR-GEAR-6','Boîte 6 rapports','gearbox',2100,75),
('AR-TIRE-STD','Pneu standard','tire',120,10),
('AR-BRAKE-STD','Kit freinage','brake',480,18),
('AR-ELEC-STD','Module électronique','electronics',900,8),
('AR-BODY-CAR','Carrosserie voiture','body',2200,280),
('AR-INT-STD','Intérieur standard','interior',1400,115),
('AR-CHASSIS-CAR','Châssis voiture','chassis',3100,340)
ON CONFLICT (sku) DO NOTHING;

INSERT INTO gold_products(code,label,gold_amount,price_cents) VALUES
('gold_500','500 Gold',500,499),
('gold_1500','1 500 Gold',1500,1299),
('gold_4000','4 000 Gold',4000,2999)
ON CONFLICT (code) DO NOTHING;


INSERT INTO raw_materials(code,name,unit,base_price,current_price,volatility) VALUES
('MAT-STEEL','Acier','tonne',900,900,0.060),
('MAT-ALU','Aluminium','tonne',2400,2400,0.080),
('MAT-COPPER','Cuivre','tonne',8500,8500,0.090),
('MAT-LITHIUM','Lithium','tonne',15000,15000,0.140),
('MAT-PLASTIC','Polymères','tonne',1600,1600,0.050),
('MAT-GLASS','Verre automobile','tonne',1100,1100,0.040)
ON CONFLICT (code) DO NOTHING;

INSERT INTO territory_metrics(entity_id)
SELECT id FROM public_entities
ON CONFLICT (entity_id) DO NOTHING;


INSERT INTO achievements(code,name,description,reward_gold,reward_xp) VALUES
('ACH_FIRST_CAR','Premières clés','Acheter son premier véhicule',10,100),
('ACH_FIRST_COMPANY','Patron','Créer sa première entreprise',20,250),
('ACH_FIRST_SALE','Première vente','Vendre un véhicule à un autre joueur',10,100),
('ACH_10_VEHICLES','Collectionneur','Posséder 10 véhicules',25,500),
('ACH_MILLION','Millionnaire','Atteindre 1 000 000 € de patrimoine',50,1000),
('ACH_ELECTED','Élu du peuple','Remporter une élection',30,600)
ON CONFLICT (code) DO NOTHING;

INSERT INTO seasons(world_id,name,starts_at,ends_at,active)
SELECT w,'Saison 1',NOW(),NOW()+INTERVAL '90 days',TRUE
FROM (VALUES ('beta'),('world1')) AS x(w)
WHERE NOT EXISTS (SELECT 1 FROM seasons s WHERE s.world_id=x.w AND s.active=TRUE);

INSERT INTO npc_market_demand(world_id,entity_id,vehicle_type,fuel_type,daily_demand,max_price)
SELECT pe.world_id,pe.id,'car',NULL,8,35000
FROM public_entities pe
WHERE pe.entity_type='city'
AND NOT EXISTS (SELECT 1 FROM npc_market_demand nd WHERE nd.entity_id=pe.id AND nd.vehicle_type='car');
