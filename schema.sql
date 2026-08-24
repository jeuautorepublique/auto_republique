
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(24) NOT NULL UNIQUE,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_banned BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  euros BIGINT NOT NULL DEFAULT 250000 CHECK(euros >= 0),
  gold BIGINT NOT NULL DEFAULT 100 CHECK(gold >= 0)
);

CREATE TABLE IF NOT EXISTS world_profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  world_id VARCHAR(20) NOT NULL CHECK(world_id IN ('beta','world1')),
  reputation INTEGER NOT NULL DEFAULT 0,
  city VARCHAR(80) NOT NULL DEFAULT 'Dijon',
  region VARCHAR(120) NOT NULL DEFAULT 'Bourgogne-Franche-Comté',
  game_day INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id,world_id)
);

CREATE TABLE IF NOT EXISTS vehicles (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL CHECK(world_id IN ('beta','world1')),
  owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  make VARCHAR(80) NOT NULL,
  model VARCHAR(80) NOT NULL,
  year INTEGER NOT NULL CHECK(year BETWEEN 1900 AND 2100),
  mileage INTEGER NOT NULL DEFAULT 0 CHECK(mileage >= 0),
  condition INTEGER NOT NULL DEFAULT 100 CHECK(condition BETWEEN 0 AND 100),
  estimated_value BIGINT NOT NULL CHECK(estimated_value >= 0),
  status VARCHAR(30) NOT NULL DEFAULT 'garage'
    CHECK(status IN ('garage','listed','rented','seized','repair')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_listings (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL CHECK(world_id IN ('beta','world1')),
  vehicle_id BIGINT NOT NULL UNIQUE REFERENCES vehicles(id) ON DELETE CASCADE,
  seller_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  price BIGINT NOT NULL CHECK(price > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','sold','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sold_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  world_id VARCHAR(20),
  currency VARCHAR(10) NOT NULL CHECK(currency IN ('EUR','GOLD')),
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reason VARCHAR(80) NOT NULL,
  reference_type VARCHAR(40),
  reference_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicle_history (
  id BIGSERIAL PRIMARY KEY,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  action TEXT NOT NULL,
  metadata JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_owner_world ON vehicles(owner_user_id, world_id);
CREATE INDEX IF NOT EXISTS idx_listings_world_status ON market_listings(world_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger_entries(user_id, created_at DESC);


-- === MODULE ENTREPRISES ===
CREATE TABLE IF NOT EXISTS companies (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL CHECK(world_id IN ('beta','world1')),
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  company_type VARCHAR(40) NOT NULL CHECK(company_type IN (
    'garage','dealership','rental','transport','parts','manufacturer','bank_private',
    'insurance','press','law_firm','bailiff_office'
  )),
  city VARCHAR(80) NOT NULL,
  region VARCHAR(120) NOT NULL,
  cash BIGINT NOT NULL DEFAULT 0 CHECK(cash >= 0),
  reputation INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === TYPES DE VEHICULES ===
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(30) NOT NULL DEFAULT 'car';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(30) NOT NULL DEFAULT 'petrol';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS seats INTEGER NOT NULL DEFAULT 5;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS payload_kg INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS power_hp INTEGER NOT NULL DEFAULT 100;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS purchase_price BIGINT NOT NULL DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS rental_daily_price BIGINT NOT NULL DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS maintenance_due_km INTEGER NOT NULL DEFAULT 15000;

-- === LOCATIONS ===
CREATE TABLE IF NOT EXISTS rentals (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  renter_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  daily_price BIGINT NOT NULL CHECK(daily_price > 0),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'available'
    CHECK(status IN ('available','active','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === REPARATIONS / GARAGES ===
CREATE TABLE IF NOT EXISTS repair_orders (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  customer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garage_company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  estimated_cost BIGINT NOT NULL DEFAULT 0,
  final_cost BIGINT,
  status VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested','quoted','accepted','in_progress','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === BANQUES ===
CREATE TABLE IF NOT EXISTS banks (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  bank_type VARCHAR(20) NOT NULL CHECK(bank_type IN ('private','municipal','regional','national')),
  owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  name VARCHAR(120) NOT NULL,
  city VARCHAR(80),
  region VARCHAR(120),
  capital BIGINT NOT NULL DEFAULT 0,
  reserve_ratio NUMERIC(6,3) NOT NULL DEFAULT 0.100,
  base_rate NUMERIC(6,3) NOT NULL DEFAULT 0.050,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id BIGSERIAL PRIMARY KEY,
  bank_id BIGINT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0 CHECK(balance >= 0),
  account_type VARCHAR(20) NOT NULL DEFAULT 'current'
    CHECK(account_type IN ('current','savings','business')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(bank_id,user_id,account_type)
);

CREATE TABLE IF NOT EXISTS loans (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  bank_id BIGINT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  borrower_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  principal BIGINT NOT NULL CHECK(principal > 0),
  balance BIGINT NOT NULL CHECK(balance >= 0),
  annual_rate NUMERIC(7,4) NOT NULL,
  term_months INTEGER NOT NULL CHECK(term_months > 0),
  purpose VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','active','repaid','defaulted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === POLITIQUE ===
CREATE TABLE IF NOT EXISTS public_entities (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  entity_type VARCHAR(20) NOT NULL CHECK(entity_type IN ('country','region','city','village')),
  name VARCHAR(120) NOT NULL,
  parent_id BIGINT REFERENCES public_entities(id) ON DELETE CASCADE,
  treasury BIGINT NOT NULL DEFAULT 0 CHECK(treasury >= 0),
  tax_business NUMERIC(6,3) NOT NULL DEFAULT 0.040,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offices (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  entity_id BIGINT NOT NULL REFERENCES public_entities(id) ON DELETE CASCADE,
  office_type VARCHAR(30) NOT NULL CHECK(office_type IN ('mayor','regional_president','president')),
  holder_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  mandate_start TIMESTAMPTZ,
  mandate_end TIMESTAMPTZ,
  UNIQUE(world_id,entity_id,office_type)
);

CREATE TABLE IF NOT EXISTS elections (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  entity_id BIGINT NOT NULL REFERENCES public_entities(id) ON DELETE CASCADE,
  office_type VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','nominations','voting','closed')),
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS election_candidates (
  election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manifesto TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(election_id,user_id)
);

CREATE TABLE IF NOT EXISTS election_votes (
  election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  voter_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(election_id,voter_user_id)
);

CREATE TABLE IF NOT EXISTS policies (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  entity_id BIGINT NOT NULL REFERENCES public_entities(id) ON DELETE CASCADE,
  created_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_type VARCHAR(40) NOT NULL CHECK(policy_type IN (
    'law','subsidy','tax','infrastructure','public_contract'
  )),
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','proposed','active','rejected','expired')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === PRESSE ===
CREATE TABLE IF NOT EXISTS media_outlets (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  scope VARCHAR(20) NOT NULL CHECK(scope IN ('local','regional','national','automotive','economic')),
  reputation INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS press_roles (
  media_id BIGINT NOT NULL REFERENCES media_outlets(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(30) NOT NULL CHECK(role IN ('owner','editor_in_chief','journalist')),
  PRIMARY KEY(media_id,user_id)
);

CREATE TABLE IF NOT EXISTS press_articles (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  media_id BIGINT NOT NULL REFERENCES media_outlets(id) ON DELETE CASCADE,
  author_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(180) NOT NULL,
  body TEXT NOT NULL,
  category VARCHAR(30) NOT NULL DEFAULT 'general',
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS news_feed (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  category VARCHAR(30) NOT NULL,
  headline VARCHAR(180) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === JUSTICE ===
CREATE TABLE IF NOT EXISTS court_cases (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  plaintiff_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  defendant_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  claim_type VARCHAR(40) NOT NULL,
  claim_amount BIGINT NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'filed'
    CHECK(status IN ('filed','scheduled','hearing','deliberation','judged','appealed','closed')),
  judge_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  hearing_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_lawyers (
  case_id BIGINT NOT NULL REFERENCES court_cases(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  side VARCHAR(20) NOT NULL CHECK(side IN ('plaintiff','defendant')),
  PRIMARY KEY(case_id,user_id)
);

CREATE TABLE IF NOT EXISTS case_evidence (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES court_cases(id) ON DELETE CASCADE,
  submitted_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evidence_type VARCHAR(30) NOT NULL,
  reference_id BIGINT,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS judgments (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL UNIQUE REFERENCES court_cases(id) ON DELETE CASCADE,
  judge_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  winner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  amount_awarded BIGINT NOT NULL DEFAULT 0,
  decision TEXT NOT NULL,
  executable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === HUISSIERS / EXECUTION ===
CREATE TABLE IF NOT EXISTS enforcement_orders (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  judgment_id BIGINT NOT NULL REFERENCES judgments(id) ON DELETE CASCADE,
  creditor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  debtor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bailiff_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  amount_total BIGINT NOT NULL CHECK(amount_total >= 0),
  amount_recovered BIGINT NOT NULL DEFAULT 0 CHECK(amount_recovered >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','partial','completed','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS enforcement_actions (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES enforcement_orders(id) ON DELETE CASCADE,
  action_type VARCHAR(30) NOT NULL CHECK(action_type IN ('bank_seizure','vehicle_seizure','asset_sale')),
  amount BIGINT NOT NULL DEFAULT 0,
  vehicle_id BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- === CONTRATS / APPELS D'OFFRES ===
CREATE TABLE IF NOT EXISTS contracts (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  issuer_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  issuer_public_entity_id BIGINT REFERENCES public_entities(id) ON DELETE SET NULL,
  title VARCHAR(160) NOT NULL,
  contract_type VARCHAR(40) NOT NULL CHECK(contract_type IN (
    'vehicle_supply','repair','transport','rental','parts','insurance','public_fleet'
  )),
  budget BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','awarded','active','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contract_bids (
  contract_id BIGINT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  bidder_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK(amount > 0),
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(contract_id,bidder_user_id)
);

CREATE INDEX IF NOT EXISTS idx_companies_owner_world ON companies(owner_user_id,world_id);
CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_user_id,status);
CREATE INDEX IF NOT EXISTS idx_cases_world_status ON court_cases(world_id,status);
CREATE INDEX IF NOT EXISTS idx_news_world_created ON news_feed(world_id,created_at DESC);


-- === INTEGRATION V1.0 ===
ALTER TABLE loans ADD COLUMN IF NOT EXISTS next_payment_at TIMESTAMPTZ;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS monthly_payment BIGINT NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS deposit BIGINT NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS total_charged BIGINT NOT NULL DEFAULT 0;
ALTER TABLE repair_orders ADD COLUMN IF NOT EXISTS quoted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS awarded_bidder_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS awarded_amount BIGINT;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS effect_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE elections ADD COLUMN IF NOT EXISTS winner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE judgments ADD COLUMN IF NOT EXISTS debtor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE judgments ADD COLUMN IF NOT EXISTS creditor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS world_clock (
  world_id VARCHAR(20) PRIMARY KEY CHECK(world_id IN ('beta','world1')),
  game_day INTEGER NOT NULL DEFAULT 1,
  last_tick_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO world_clock(world_id,game_day) VALUES ('beta',1),('world1',1)
ON CONFLICT (world_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS scheduled_events (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  reference_id BIGINT,
  execute_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','done','cancelled','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  world_id VARCHAR(20),
  title VARCHAR(160) NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_due ON scheduled_events(status,execute_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC);


-- === V1.1 PERMISSIONS / TEMPS REEL / ENCHERES ===
CREATE TABLE IF NOT EXISTS user_roles (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  world_id VARCHAR(20),
  role VARCHAR(40) NOT NULL CHECK(role IN (
    'admin','moderator','judge','journalist','editor_in_chief','lawyer','bailiff',
    'banker','mayor','regional_president','president'
  )),
  granted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id,world_id,role)
);

CREATE TABLE IF NOT EXISTS judicial_auctions (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  enforcement_order_id BIGINT NOT NULL REFERENCES enforcement_orders(id) ON DELETE CASCADE,
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  starting_price BIGINT NOT NULL CHECK(starting_price > 0),
  highest_bid BIGINT NOT NULL DEFAULT 0,
  highest_bidder_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
    CHECK(status IN ('scheduled','open','closed','cancelled')),
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS judicial_bids (
  auction_id BIGINT NOT NULL REFERENCES judicial_auctions(id) ON DELETE CASCADE,
  bidder_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK(amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(auction_id,bidder_user_id)
);

CREATE INDEX IF NOT EXISTS idx_roles_user_world ON user_roles(user_id,world_id);
CREATE INDEX IF NOT EXISTS idx_auctions_world_status ON judicial_auctions(world_id,status);


-- === V1.2 INDUSTRIE / ASSURANCE / LOGISTIQUE / CAPITAL / GOLD ===

-- Pièces et moteurs
CREATE TABLE IF NOT EXISTS parts_catalog (
  id BIGSERIAL PRIMARY KEY,
  sku VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(40) NOT NULL CHECK(category IN (
    'engine','battery','gearbox','tire','brake','electronics','body','interior','chassis'
  )),
  base_value BIGINT NOT NULL CHECK(base_value >= 0),
  unit_weight_kg INTEGER NOT NULL DEFAULT 1 CHECK(unit_weight_kg >= 0)
);

CREATE TABLE IF NOT EXISTS part_inventory (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  part_id BIGINT NOT NULL REFERENCES parts_catalog(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  PRIMARY KEY(company_id,part_id)
);

-- Usines
CREATE TABLE IF NOT EXISTS factories (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  city VARCHAR(80) NOT NULL,
  factory_type VARCHAR(30) NOT NULL CHECK(factory_type IN ('vehicle','parts','engine','battery')),
  level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 20),
  capacity_per_day INTEGER NOT NULL DEFAULT 5 CHECK(capacity_per_day > 0),
  operating_cost_per_day BIGINT NOT NULL DEFAULT 5000 CHECK(operating_cost_per_day >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vehicle_blueprints (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  manufacturer_company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  make VARCHAR(80) NOT NULL,
  model VARCHAR(80) NOT NULL,
  vehicle_type VARCHAR(30) NOT NULL CHECK(vehicle_type IN ('car','van','truck','bus')),
  fuel_type VARCHAR(30) NOT NULL CHECK(fuel_type IN ('petrol','diesel','hybrid','electric','hydrogen')),
  seats INTEGER NOT NULL DEFAULT 5,
  payload_kg INTEGER NOT NULL DEFAULT 0,
  power_hp INTEGER NOT NULL DEFAULT 100,
  target_value BIGINT NOT NULL CHECK(target_value > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blueprint_parts (
  blueprint_id BIGINT NOT NULL REFERENCES vehicle_blueprints(id) ON DELETE CASCADE,
  part_id BIGINT NOT NULL REFERENCES parts_catalog(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  PRIMARY KEY(blueprint_id,part_id)
);

CREATE TABLE IF NOT EXISTS production_orders (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  factory_id BIGINT NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  blueprint_id BIGINT REFERENCES vehicle_blueprints(id) ON DELETE CASCADE,
  part_id BIGINT REFERENCES parts_catalog(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  completed_quantity INTEGER NOT NULL DEFAULT 0 CHECK(completed_quantity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Assurances / sinistres
CREATE TABLE IF NOT EXISTS insurance_products (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  insurer_company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  coverage_type VARCHAR(30) NOT NULL CHECK(coverage_type IN ('third_party','comprehensive','fleet')),
  monthly_premium BIGINT NOT NULL CHECK(monthly_premium > 0),
  deductible BIGINT NOT NULL DEFAULT 0 CHECK(deductible >= 0),
  max_payout BIGINT NOT NULL CHECK(max_payout > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS insurance_policies (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  product_id BIGINT NOT NULL REFERENCES insurance_products(id) ON DELETE CASCADE,
  holder_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','cancelled','expired')),
  next_payment_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '1 month',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS insurance_claims (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  policy_id BIGINT NOT NULL REFERENCES insurance_policies(id) ON DELETE CASCADE,
  claimant_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  incident_type VARCHAR(30) NOT NULL CHECK(incident_type IN ('collision','theft','fire','vandalism','breakdown')),
  description TEXT NOT NULL,
  requested_amount BIGINT NOT NULL CHECK(requested_amount >= 0),
  approved_amount BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'submitted'
    CHECK(status IN ('submitted','review','approved','rejected','paid')),
  reviewed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Transport / logistique
CREATE TABLE IF NOT EXISTS logistics_jobs (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  requester_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  carrier_company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  cargo_type VARCHAR(30) NOT NULL CHECK(cargo_type IN ('vehicle','parts','mixed')),
  origin_city VARCHAR(80) NOT NULL,
  destination_city VARCHAR(80) NOT NULL,
  vehicle_id BIGINT REFERENCES vehicles(id) ON DELETE SET NULL,
  part_id BIGINT REFERENCES parts_catalog(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
  offered_price BIGINT NOT NULL CHECK(offered_price > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','accepted','in_transit','delivered','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

-- Capital, actions et bourse d'entreprises
ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_shares BIGINT NOT NULL DEFAULT 1000000;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS public_company BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS share_price BIGINT NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS company_shareholdings (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shares BIGINT NOT NULL CHECK(shares >= 0),
  PRIMARY KEY(company_id,user_id)
);

CREATE TABLE IF NOT EXISTS share_orders (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  side VARCHAR(10) NOT NULL CHECK(side IN ('buy','sell')),
  shares BIGINT NOT NULL CHECK(shares > 0),
  price_per_share BIGINT NOT NULL CHECK(price_per_share > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','filled','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS share_trades (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  buyer_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shares BIGINT NOT NULL,
  price_per_share BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Gold réel via webhook signé
CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  provider VARCHAR(30) NOT NULL,
  provider_event_id VARCHAR(160) NOT NULL UNIQUE,
  event_type VARCHAR(60) NOT NULL,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  gold_amount BIGINT NOT NULL DEFAULT 0,
  raw_payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'received'
    CHECK(status IN ('received','processed','ignored','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gold_products (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(120) NOT NULL,
  gold_amount BIGINT NOT NULL CHECK(gold_amount > 0),
  price_cents INTEGER NOT NULL CHECK(price_cents > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_factory_company ON factories(company_id);
CREATE INDEX IF NOT EXISTS idx_prod_world_status ON production_orders(world_id,status);
CREATE INDEX IF NOT EXISTS idx_claim_world_status ON insurance_claims(world_id,status);
CREATE INDEX IF NOT EXISTS idx_logistics_world_status ON logistics_jobs(world_id,status);
CREATE INDEX IF NOT EXISTS idx_share_orders_open ON share_orders(company_id,status);


-- === V1.4 ECONOMIE AUTOMATIQUE ===

CREATE TABLE IF NOT EXISTS raw_materials (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  base_price BIGINT NOT NULL CHECK(base_price > 0),
  current_price BIGINT NOT NULL CHECK(current_price > 0),
  volatility NUMERIC(6,3) NOT NULL DEFAULT 0.050
);

CREATE TABLE IF NOT EXISTS company_material_inventory (
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  material_id BIGINT NOT NULL REFERENCES raw_materials(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  PRIMARY KEY(company_id,material_id)
);

CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_name VARCHAR(100) NOT NULL,
  role VARCHAR(60) NOT NULL,
  salary_daily BIGINT NOT NULL CHECK(salary_daily >= 0),
  productivity INTEGER NOT NULL DEFAULT 100 CHECK(productivity BETWEEN 1 AND 300),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  hired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_financials (
  company_id BIGINT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  debt BIGINT NOT NULL DEFAULT 0,
  unpaid_wages BIGINT NOT NULL DEFAULT 0,
  unpaid_taxes BIGINT NOT NULL DEFAULT 0,
  insolvency_days INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','warning','insolvent','bankrupt','liquidation'))
);

CREATE TABLE IF NOT EXISTS tax_assessments (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  public_entity_id BIGINT REFERENCES public_entities(id) ON DELETE SET NULL,
  tax_type VARCHAR(30) NOT NULL CHECK(tax_type IN ('business','payroll','vehicle','transaction')),
  amount BIGINT NOT NULL CHECK(amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'due'
    CHECK(status IN ('due','paid','overdue','cancelled')),
  due_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS territory_metrics (
  entity_id BIGINT PRIMARY KEY REFERENCES public_entities(id) ON DELETE CASCADE,
  population INTEGER NOT NULL DEFAULT 100000,
  employment_rate NUMERIC(6,3) NOT NULL DEFAULT 0.850,
  economic_index NUMERIC(8,3) NOT NULL DEFAULT 100.000,
  vehicle_demand_index NUMERIC(8,3) NOT NULL DEFAULT 100.000,
  logistics_index NUMERIC(8,3) NOT NULL DEFAULT 100.000,
  industry_index NUMERIC(8,3) NOT NULL DEFAULT 100.000,
  last_update_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public_tenders (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  entity_id BIGINT NOT NULL REFERENCES public_entities(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  tender_type VARCHAR(40) NOT NULL CHECK(tender_type IN (
    'vehicles','repair','transport','insurance','parts','infrastructure'
  )),
  budget BIGINT NOT NULL CHECK(budget > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','evaluating','awarded','completed','cancelled')),
  winner_company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  awarded_amount BIGINT,
  closes_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public_tender_bids (
  tender_id BIGINT NOT NULL REFERENCES public_tenders(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK(amount > 0),
  quality_score INTEGER NOT NULL DEFAULT 50 CHECK(quality_score BETWEEN 0 AND 100),
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(tender_id,company_id)
);

CREATE TABLE IF NOT EXISTS bankruptcy_cases (
  id BIGSERIAL PRIMARY KEY,
  world_id VARCHAR(20) NOT NULL,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'opened'
    CHECK(status IN ('opened','restructuring','liquidation','closed')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tax_due ON tax_assessments(status,due_at);
CREATE INDEX IF NOT EXISTS idx_tenders_world_status ON public_tenders(world_id,status);
CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id,active);
