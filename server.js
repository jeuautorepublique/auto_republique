
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import { z } from "zod";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { query, withTransaction, createStarterData, logAudit } from "./db.js";
import {
  authRequired, createAccessToken, createRefreshToken, rotateRefreshToken,
  revokeRefreshToken, setAuthCookies, clearAuthCookies
} from "./auth.js";


async function emitNews(worldId, category, headline, details={}){
  await query(`INSERT INTO news_feed(world_id,category,headline,details) VALUES ($1,$2,$3,$4::jsonb)`,
    [worldId,category,headline,JSON.stringify(details)]);
}
async function notify(userId, worldId, title, body){
  await query(`INSERT INTO notifications(user_id,world_id,title,body) VALUES ($1,$2,$3,$4)`,
    [userId,worldId,title,body]);
}
async function getOfficeForUser(userId, worldId, entityId){
  const {rows}=await query(`
    SELECT o.*,pe.entity_type,pe.name FROM offices o
    JOIN public_entities pe ON pe.id=o.entity_id
    WHERE o.holder_user_id=$1 AND o.world_id=$2 AND o.entity_id=$3
  `,[userId,worldId,entityId]);
  return rows[0];
}


const liveClients = new Map();

function verifyPaymentSignature(rawPayload,signature){
  const secret=process.env.PAYMENT_WEBHOOK_SECRET||"";
  if(!secret || !signature)return false;
  const expected=crypto.createHmac("sha256",secret).update(rawPayload).digest("hex");
  try{
    return crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signature,"hex"));
  }catch{return false;}
}


function roleKey(userId, worldId){ return `${userId}:${worldId||"*"} `; }

async function hasRole(userId, worldId, roles){
  const {rows}=await query(`
    SELECT role FROM user_roles
    WHERE user_id=$1 AND (world_id=$2 OR world_id IS NULL)
  `,[userId,worldId]);
  return rows.some(r=>roles.includes(r.role));
}

function requireRoles(roles){
  return async (req,res,next)=>{
    try{
      const ok=await hasRole(req.user.id,req.params.worldId||null,roles);
      if(!ok)return res.status(403).json({error:"Permission insuffisante"});
      next();
    }catch(e){next(e);}
  };
}

function broadcast(worldId,type,payload={}){
  const msg=JSON.stringify({type,worldId,payload,ts:new Date().toISOString()});
  for(const ws of liveClients.values()){
    if(ws.readyState===1 && (!ws.worldId || ws.worldId===worldId)) ws.send(msg);
  }
}

async function broadcastNews(worldId,category,headline,details={}){
  await emitNews(worldId,category,headline,details);
  broadcast(worldId,"news",{category,headline,details});
}

function adminKeyRequired(req,res,next){
  const key=req.headers["x-admin-key"];
  if(!process.env.ADMIN_API_KEY || key!==process.env.ADMIN_API_KEY)
    return res.status(403).json({error:"Clé admin invalide"});
  next();
}

function cronSecretRequired(req,res,next){
  const key=req.headers["x-cron-secret"];
  if(!process.env.CRON_SECRET || key!==process.env.CRON_SECRET)
    return res.status(403).json({error:"Secret cron invalide"});
  next();
}


async function companyOwnerId(companyId){
  const r=await query(`SELECT owner_user_id FROM companies WHERE id=$1`,[companyId]);
  return r.rows[0]?.owner_user_id || null;
}

async function updateCompanySolvency(client, companyId){
  const co=(await client.query(`
    SELECT c.id,c.cash,cf.debt,cf.unpaid_wages,cf.unpaid_taxes,cf.insolvency_days,cf.status
    FROM companies c
    LEFT JOIN company_financials cf ON cf.company_id=c.id
    WHERE c.id=$1 FOR UPDATE
  `,[companyId])).rows[0];
  if(!co)return;
  const liabilities=Number(co.debt||0)+Number(co.unpaid_wages||0)+Number(co.unpaid_taxes||0);
  let days=Number(co.insolvency_days||0);
  if(Number(co.cash)<=0 && liabilities>0) days+=1; else days=0;
  let status='active';
  if(days>=3)status='warning';
  if(days>=7)status='insolvent';
  if(days>=14)status='bankrupt';
  await client.query(`
    INSERT INTO company_financials(company_id,insolvency_days,status)
    VALUES ($1,$2,$3)
    ON CONFLICT(company_id) DO UPDATE SET insolvency_days=$2,status=$3
  `,[companyId,days,status]);
  if(status==='bankrupt'){
    await client.query(`UPDATE companies SET reputation=GREATEST(0,reputation-20) WHERE id=$1`,[companyId]);
    await client.query(`
      INSERT INTO bankruptcy_cases(world_id,company_id,reason,status)
      SELECT world_id,id,'Insolvabilité prolongée','opened'
      FROM companies
      WHERE id=$1
      AND NOT EXISTS (
        SELECT 1 FROM bankruptcy_cases bc
        WHERE bc.company_id=$1 AND bc.status IN ('opened','restructuring','liquidation')
      )
    `,[companyId]);
  }
}

const app=express();
app.set("trust proxy",1);
app.use(helmet({crossOriginResourcePolicy:{policy:"cross-origin"}}));
app.use(express.json({limit:"64kb",verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf);}}));
app.use(cookieParser());
app.use(cors({
  origin:process.env.CLIENT_ORIGIN||"http://localhost:8080",
  credentials:true
}));

const authLimiter=rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:true,legacyHeaders:false});
const actionLimiter=rateLimit({windowMs:60*1000,limit:120,standardHeaders:true,legacyHeaders:false});

const registerSchema=z.object({
  username:z.string().regex(/^[A-Za-zÀ-ÿ0-9_-]{3,24}$/),
  email:z.string().email().max(160),
  password:z.string().min(10).max(128)
});
const loginSchema=z.object({login:z.string().min(3).max(160),password:z.string().min(1).max(128)});

app.get("/api/health",(req,res)=>res.json({ok:true,service:"auto-republique",version:"0.8.0"}));

app.post("/api/auth/register",authLimiter,async(req,res,next)=>{
  try{
    const parsed=registerSchema.safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:"Données invalides"});
    const {username,email,password}=parsed.data;
    const existing=await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2)`,[username,email]);
    if(existing.rowCount) return res.status(409).json({error:"Pseudo ou e-mail déjà utilisé"});
    const hash=await argon2.hash(password,{type:argon2.argon2id});
    const created=await query(
      `INSERT INTO users(username,email,password_hash) VALUES ($1,$2,$3)
       RETURNING id,username,email`,[username,email.toLowerCase(),hash]);
    const user=created.rows[0];
    await createStarterData(user.id);
    const access=createAccessToken(user),refresh=await createRefreshToken(user.id);
    setAuthCookies(res,access,refresh);
    await logAudit(user.id,"register",null,req.ip);
    res.status(201).json({user});
  }catch(e){next(e);}
});

app.post("/api/auth/login",authLimiter,async(req,res,next)=>{
  try{
    const parsed=loginSchema.safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:"Données invalides"});
    const {login,password}=parsed.data;
    const found=await query(`SELECT * FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1)`,[login]);
    const user=found.rows[0];
    if(!user || !(await argon2.verify(user.password_hash,password))){
      await logAudit(user?.id,"login_failed",{login},req.ip);
      return res.status(401).json({error:"Identifiants incorrects"});
    }
    if(user.is_banned) return res.status(403).json({error:"Compte suspendu"});
    const access=createAccessToken(user),refresh=await createRefreshToken(user.id);
    setAuthCookies(res,access,refresh);
    await logAudit(user.id,"login",null,req.ip);
    res.json({user:{id:user.id,username:user.username,email:user.email}});
  }catch(e){next(e);}
});

app.post("/api/auth/refresh",authLimiter,async(req,res,next)=>{
  try{
    const rotated=await rotateRefreshToken(req.cookies?.ar_refresh);
    if(!rotated){clearAuthCookies(res);return res.status(401).json({error:"Session expirée"});}
    setAuthCookies(res,rotated.access,rotated.refresh);
    res.json({user:rotated.user});
  }catch(e){next(e);}
});

app.post("/api/auth/logout",async(req,res,next)=>{
  try{
    if(req.cookies?.ar_refresh) await revokeRefreshToken(req.cookies.ar_refresh);
    clearAuthCookies(res);res.json({ok:true});
  }catch(e){next(e);}
});

app.get("/api/me",authRequired,async(req,res,next)=>{
  try{
    const u=(await query(`SELECT id,username,email,created_at FROM users WHERE id=$1`,[req.user.id])).rows[0];
    const wallet=(await query(`SELECT euros,gold FROM wallets WHERE user_id=$1`,[req.user.id])).rows[0];
    const worlds=(await query(`SELECT world_id,reputation,city,region,game_day FROM world_profiles WHERE user_id=$1 ORDER BY world_id`,[req.user.id])).rows;
    res.json({user:u,wallet,worlds});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/market",authRequired,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    if(!["beta","world1"].includes(worldId)) return res.status(400).json({error:"Monde invalide"});
    const {rows}=await query(`
      SELECT ml.id AS listing_id,ml.price,v.id AS vehicle_id,v.make,v.model,v.year,
             v.mileage,v.condition,v.estimated_value,
             COALESCE(u.username,'Marché système') AS seller
      FROM market_listings ml
      JOIN vehicles v ON v.id=ml.vehicle_id
      LEFT JOIN users u ON u.id=ml.seller_user_id
      WHERE ml.world_id=$1 AND ml.status='active'
      ORDER BY ml.created_at DESC LIMIT 100
    `,[worldId]);
    res.json({listings:rows});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/garage",authRequired,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    const {rows}=await query(`
      SELECT id,make,model,year,mileage,condition,estimated_value,status
      FROM vehicles WHERE owner_user_id=$1 AND world_id=$2
      ORDER BY created_at DESC
    `,[req.user.id,worldId]);
    res.json({vehicles:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/market/:listingId/buy",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    const listingId=Number(req.params.listingId);
    if(!["beta","world1"].includes(worldId) || !Number.isInteger(listingId)) return res.status(400).json({error:"Requête invalide"});

    const result=await withTransaction(async c=>{
      const lr=await c.query(`
        SELECT ml.*,v.owner_user_id,v.make,v.model
        FROM market_listings ml JOIN vehicles v ON v.id=ml.vehicle_id
        WHERE ml.id=$1 AND ml.world_id=$2 FOR UPDATE
      `,[listingId,worldId]);
      const listing=lr.rows[0];
      if(!listing || listing.status!=="active") throw Object.assign(new Error("Annonce indisponible"),{status:409});
      if(Number(listing.seller_user_id)===req.user.id) throw Object.assign(new Error("Impossible d'acheter votre propre véhicule"),{status:400});

      const wr=await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id]);
      const wallet=wr.rows[0];
      if(!wallet || Number(wallet.euros)<Number(listing.price)) throw Object.assign(new Error("Fonds insuffisants"),{status:409});

      const buyerBalance=Number(wallet.euros)-Number(listing.price);
      await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,[buyerBalance,req.user.id]);
      await c.query(`
        INSERT INTO ledger_entries(user_id,world_id,currency,amount,balance_after,reason,reference_type,reference_id)
        VALUES ($1,$2,'EUR',$3,$4,'VEHICLE_PURCHASE','market_listing',$5)
      `,[req.user.id,worldId,-Number(listing.price),buyerBalance,listing.id]);

      if(listing.seller_user_id){
        const sw=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[listing.seller_user_id])).rows[0];
        const sellerBalance=Number(sw.euros)+Number(listing.price);
        await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,[sellerBalance,listing.seller_user_id]);
        await c.query(`
          INSERT INTO ledger_entries(user_id,world_id,currency,amount,balance_after,reason,reference_type,reference_id)
          VALUES ($1,$2,'EUR',$3,$4,'VEHICLE_SALE','market_listing',$5)
        `,[listing.seller_user_id,worldId,Number(listing.price),sellerBalance,listing.id]);
      }

      await c.query(`UPDATE vehicles SET owner_user_id=$1,status='garage' WHERE id=$2`,[req.user.id,listing.vehicle_id]);
      await c.query(`UPDATE market_listings SET status='sold',sold_at=NOW() WHERE id=$1`,[listing.id]);
      await c.query(`
        INSERT INTO vehicle_history(vehicle_id,event_type,actor_user_id,details)
        VALUES ($1,'SALE',$2,$3::jsonb)
      `,[listing.vehicle_id,req.user.id,JSON.stringify({price:Number(listing.price),worldId})]);
      return {vehicleId:listing.vehicle_id,balance:buyerBalance,price:Number(listing.price),name:`${listing.make} ${listing.model}`};
    });
    res.json({ok:true,...result});
  }catch(e){ if(e.status) return res.status(e.status).json({error:e.message}); next(e); }
});

app.post("/api/world/:worldId/garage/:vehicleId/list",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId,vehicleId=Number(req.params.vehicleId);
    const parsed=z.object({price:z.number().int().min(500).max(100000000)}).safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:"Prix invalide"});
    const listing=await withTransaction(async c=>{
      const vr=(await c.query(`SELECT * FROM vehicles WHERE id=$1 AND owner_user_id=$2 AND world_id=$3 FOR UPDATE`,
        [vehicleId,req.user.id,worldId])).rows[0];
      if(!vr) throw Object.assign(new Error("Véhicule introuvable"),{status:404});
      if(vr.status!=="garage") throw Object.assign(new Error("Ce véhicule ne peut pas être mis en vente"),{status:409});
      await c.query(`UPDATE vehicles SET status='listed' WHERE id=$1`,[vehicleId]);
      const lr=await c.query(`
        INSERT INTO market_listings(world_id,vehicle_id,seller_user_id,price,status)
        VALUES ($1,$2,$3,$4,'active') RETURNING id,price
      `,[worldId,vehicleId,req.user.id,parsed.data.price]);
      await c.query(`
        INSERT INTO vehicle_history(vehicle_id,event_type,actor_user_id,details)
        VALUES ($1,'LISTED',$2,$3::jsonb)
      `,[vehicleId,req.user.id,JSON.stringify({price:parsed.data.price})]);
      return lr.rows[0];
    });
    res.status(201).json({ok:true,listing});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.get("/api/ledger",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT id,world_id,currency,amount,balance_after,reason,reference_type,reference_id,created_at
      FROM ledger_entries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100
    `,[req.user.id]);
    res.json({entries:rows});
  }catch(e){next(e);}
});



// ---------- VEHICULES / CATALOGUE ----------
app.get("/api/world/:worldId/vehicles/catalog",authRequired,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    const {rows}=await query(`
      SELECT id,make,model,year,mileage,condition,estimated_value,status,
             vehicle_type,fuel_type,seats,payload_kg,power_hp,rental_daily_price
      FROM vehicles WHERE world_id=$1
      ORDER BY vehicle_type,make,model LIMIT 250
    `,[worldId]);
    res.json({vehicles:rows});
  }catch(e){next(e);}
});

// ---------- ENTREPRISES ----------
app.get("/api/world/:worldId/companies",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`SELECT * FROM companies WHERE world_id=$1 ORDER BY reputation DESC,created_at DESC LIMIT 200`,[req.params.worldId]);
    res.json({companies:rows});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/companies",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      name:z.string().min(3).max(120),
      type:z.enum(['garage','dealership','rental','transport','parts','manufacturer','bank_private','insurance','press','law_firm','bailiff_office']),
      city:z.string().min(1).max(80),
      region:z.string().min(1).max(120)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Données invalides"});
    const creationCost=25000;
    const company=await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<creationCost)throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      const balance=Number(w.euros)-creationCost;
      await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,[balance,req.user.id]);
      const r=await c.query(`
        INSERT INTO companies(world_id,owner_user_id,name,company_type,city,region,cash)
        VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING *
      `,[req.params.worldId,req.user.id,parsed.data.name,parsed.data.type,parsed.data.city,parsed.data.region]);
      await c.query(`
        INSERT INTO ledger_entries(user_id,world_id,currency,amount,balance_after,reason,reference_type,reference_id)
        VALUES ($1,$2,'EUR',$3,$4,'COMPANY_CREATION','company',$5)
      `,[req.user.id,req.params.worldId,-creationCost,balance,r.rows[0].id]);
      return r.rows[0];
    });
    res.status(201).json({company});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ---------- BANQUES ----------
app.get("/api/world/:worldId/banks",authRequired,async(req,res,next)=>{
  try{
    const banks=(await query(`SELECT * FROM banks WHERE world_id=$1 ORDER BY bank_type,name`,[req.params.worldId])).rows;
    const loans=(await query(`SELECT l.*,b.name AS bank_name FROM loans l JOIN banks b ON b.id=l.bank_id WHERE l.borrower_user_id=$1 AND l.world_id=$2 ORDER BY l.created_at DESC`,[req.user.id,req.params.worldId])).rows;
    res.json({banks,loans});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/banks/:bankId/loans",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      principal:z.number().int().min(1000).max(50000000),
      termMonths:z.number().int().min(6).max(120),
      purpose:z.string().min(3).max(80)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Demande invalide"});
    const bank=(await query(`SELECT * FROM banks WHERE id=$1 AND world_id=$2`,[req.params.bankId,req.params.worldId])).rows[0];
    if(!bank)return res.status(404).json({error:"Banque introuvable"});
    const autoApprove=bank.bank_type!=="private" && parsed.data.principal<=100000;
    const status=autoApprove?"active":"pending";
    const loan=await withTransaction(async c=>{
      const lr=await c.query(`
        INSERT INTO loans(world_id,bank_id,borrower_user_id,principal,balance,annual_rate,term_months,purpose,status)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8) RETURNING *
      `,[req.params.worldId,bank.id,req.user.id,parsed.data.principal,bank.base_rate,parsed.data.termMonths,parsed.data.purpose,status]);
      const monthly=Math.ceil(parsed.data.principal/parsed.data.termMonths);
      await c.query(`UPDATE loans SET monthly_payment=$1,next_payment_at=NOW()+INTERVAL '1 month' WHERE id=$2`,[monthly,lr.rows[0].id]);
      if(autoApprove){
        const wr=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
        const newBal=Number(wr.euros)+parsed.data.principal;
        await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,[newBal,req.user.id]);
        await c.query(`
          INSERT INTO ledger_entries(user_id,world_id,currency,amount,balance_after,reason,reference_type,reference_id)
          VALUES ($1,$2,'EUR',$3,$4,'LOAN_DISBURSEMENT','loan',$5)
        `,[req.user.id,req.params.worldId,parsed.data.principal,newBal,lr.rows[0].id]);
      }
      return lr.rows[0];
    });
    res.status(201).json({loan});
  }catch(e){next(e);}
});

// ---------- POLITIQUE ----------
app.get("/api/world/:worldId/politics",authRequired,async(req,res,next)=>{
  try{
    const entities=(await query(`SELECT * FROM public_entities WHERE world_id=$1 ORDER BY entity_type,name`,[req.params.worldId])).rows;
    const elections=(await query(`
      SELECT e.*,pe.name AS entity_name FROM elections e JOIN public_entities pe ON pe.id=e.entity_id
      WHERE e.world_id=$1 ORDER BY e.created_at DESC LIMIT 50
    `,[req.params.worldId])).rows;
    const policies=(await query(`
      SELECT p.*,pe.name AS entity_name FROM policies p JOIN public_entities pe ON pe.id=p.entity_id
      WHERE p.world_id=$1 ORDER BY p.created_at DESC LIMIT 50
    `,[req.params.worldId])).rows;
    res.json({entities,elections,policies});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/politics/policies",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      entityId:z.number().int().positive(),
      policyType:z.enum(['law','subsidy','tax','infrastructure','public_contract']),
      title:z.string().min(3).max(160),
      description:z.string().min(5).max(2000),
      amount:z.number().int().min(0).max(1000000000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Proposition invalide"});
    const ent=(await query(`SELECT * FROM public_entities WHERE id=$1 AND world_id=$2`,[parsed.data.entityId,req.params.worldId])).rows[0];
    if(!ent)return res.status(404).json({error:"Territoire introuvable"});
    const p=(await query(`
      INSERT INTO policies(world_id,entity_id,created_by_user_id,policy_type,title,description,amount,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed') RETURNING *
    `,[req.params.worldId,ent.id,req.user.id,parsed.data.policyType,parsed.data.title,parsed.data.description,parsed.data.amount])).rows[0];
    await query(`INSERT INTO news_feed(world_id,category,headline,details) VALUES ($1,'politics',$2,$3::jsonb)`,
      [req.params.worldId,`Nouvelle proposition : ${p.title}`,JSON.stringify({policyId:p.id,entity:ent.name})]);
    res.status(201).json({policy:p});
  }catch(e){next(e);}
});

// ---------- PRESSE ----------
app.get("/api/world/:worldId/press/feed",authRequired,async(req,res,next)=>{
  try{
    const feed=(await query(`SELECT * FROM news_feed WHERE world_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.params.worldId])).rows;
    const articles=(await query(`
      SELECT pa.*,mo.name AS media_name,u.username AS author
      FROM press_articles pa JOIN media_outlets mo ON mo.id=pa.media_id
      JOIN users u ON u.id=pa.author_user_id
      WHERE pa.world_id=$1 AND pa.published=TRUE
      ORDER BY pa.published_at DESC NULLS LAST LIMIT 100
    `,[req.params.worldId])).rows;
    res.json({feed,articles});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/press/media",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({name:z.string().min(3).max(120),scope:z.enum(['local','regional','national','automotive','economic'])}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Données invalides"});
    const media=await withTransaction(async c=>{
      const m=(await c.query(`INSERT INTO media_outlets(world_id,owner_user_id,name,scope) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.worldId,req.user.id,parsed.data.name,parsed.data.scope])).rows[0];
      await c.query(`INSERT INTO press_roles(media_id,user_id,role) VALUES ($1,$2,'owner')`,[m.id,req.user.id]);
      return m;
    });
    res.status(201).json({media});
  }catch(e){next(e);}
});

// ---------- JUSTICE ----------
app.get("/api/world/:worldId/justice",authRequired,async(req,res,next)=>{
  try{
    const cases=(await query(`
      SELECT c.*,pu.username AS plaintiff,du.username AS defendant
      FROM court_cases c JOIN users pu ON pu.id=c.plaintiff_user_id
      LEFT JOIN users du ON du.id=c.defendant_user_id
      WHERE c.world_id=$1 AND (c.plaintiff_user_id=$2 OR c.defendant_user_id=$2)
      ORDER BY c.created_at DESC LIMIT 100
    `,[req.params.worldId,req.user.id])).rows;
    res.json({cases});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/justice/cases",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      defendantUsername:z.string().min(3).max(24),
      claimType:z.string().min(3).max(40),
      claimAmount:z.number().int().min(0).max(1000000000),
      summary:z.string().min(10).max(4000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Dossier invalide"});
    const d=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[parsed.data.defendantUsername])).rows[0];
    if(!d)return res.status(404).json({error:"Défendeur introuvable"});
    const c=(await query(`
      INSERT INTO court_cases(world_id,plaintiff_user_id,defendant_user_id,claim_type,claim_amount,summary)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `,[req.params.worldId,req.user.id,d.id,parsed.data.claimType,parsed.data.claimAmount,parsed.data.summary])).rows[0];
    await query(`INSERT INTO news_feed(world_id,category,headline,details) VALUES ($1,'justice',$2,$3::jsonb)`,
      [req.params.worldId,`Nouvelle affaire judiciaire #${c.id}`,JSON.stringify({caseId:c.id,claimAmount:parsed.data.claimAmount})]);
    res.status(201).json({case:c});
  }catch(e){next(e);}
});

// ---------- HUISSIER ----------
app.get("/api/world/:worldId/enforcement",authRequired,async(req,res,next)=>{
  try{
    const orders=(await query(`
      SELECT eo.*,j.case_id,cu.username AS creditor,du.username AS debtor
      FROM enforcement_orders eo
      JOIN judgments j ON j.id=eo.judgment_id
      JOIN users cu ON cu.id=eo.creditor_user_id
      JOIN users du ON du.id=eo.debtor_user_id
      WHERE eo.world_id=$1 AND (eo.creditor_user_id=$2 OR eo.debtor_user_id=$2 OR eo.bailiff_user_id=$2)
      ORDER BY eo.created_at DESC LIMIT 100
    `,[req.params.worldId,req.user.id])).rows;
    res.json({orders});
  }catch(e){next(e);}
});

// ---------- CONTRATS / APPELS D'OFFRES ----------
app.get("/api/world/:worldId/contracts",authRequired,async(req,res,next)=>{
  try{
    const contracts=(await query(`SELECT * FROM contracts WHERE world_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.params.worldId])).rows;
    res.json({contracts});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/contracts",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      title:z.string().min(3).max(160),
      contractType:z.enum(['vehicle_supply','repair','transport','rental','parts','insurance','public_fleet']),
      budget:z.number().int().min(0).max(1000000000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Contrat invalide"});
    const c=(await query(`
      INSERT INTO contracts(world_id,issuer_user_id,title,contract_type,budget)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `,[req.params.worldId,req.user.id,parsed.data.title,parsed.data.contractType,parsed.data.budget])).rows[0];
    res.status(201).json({contract:c});
  }catch(e){next(e);}
});



// ===== NOTIFICATIONS =====
app.get("/api/notifications",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.id]);
    res.json({notifications:rows});
  }catch(e){next(e);}
});
app.post("/api/notifications/:id/read",authRequired,async(req,res,next)=>{
  try{
    await query(`UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2`,[req.params.id,req.user.id]);
    res.json({ok:true});
  }catch(e){next(e);}
});

// ===== ELECTIONS COMPLETE FLOW =====
app.post("/api/world/:worldId/elections",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      entityId:z.number().int().positive(),
      officeType:z.enum(['mayor','regional_president','president']),
      opensAt:z.string().datetime(),
      closesAt:z.string().datetime()
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Election invalide"});
    const ent=(await query(`SELECT * FROM public_entities WHERE id=$1 AND world_id=$2`,[parsed.data.entityId,req.params.worldId])).rows[0];
    if(!ent)return res.status(404).json({error:"Territoire introuvable"});
    const e=(await query(`
      INSERT INTO elections(world_id,entity_id,office_type,status,opens_at,closes_at)
      VALUES ($1,$2,$3,'nominations',$4,$5) RETURNING *
    `,[req.params.worldId,ent.id,parsed.data.officeType,parsed.data.opensAt,parsed.data.closesAt])).rows[0];
    await emitNews(req.params.worldId,"politics",`Élection annoncée à ${ent.name}`,{electionId:e.id,officeType:e.office_type});
    res.status(201).json({election:e});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/elections/:electionId/candidates",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({manifesto:z.string().min(10).max(3000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Programme invalide"});
    const el=(await query(`SELECT * FROM elections WHERE id=$1 AND world_id=$2`,[req.params.electionId,req.params.worldId])).rows[0];
    if(!el||!['nominations','scheduled'].includes(el.status))return res.status(409).json({error:"Candidatures fermées"});
    await query(`INSERT INTO election_candidates(election_id,user_id,manifesto) VALUES ($1,$2,$3)
                 ON CONFLICT (election_id,user_id) DO UPDATE SET manifesto=EXCLUDED.manifesto`,
      [el.id,req.user.id,parsed.data.manifesto]);
    await emitNews(req.params.worldId,"politics",`${req.user.username} se porte candidat`,{electionId:el.id});
    res.json({ok:true});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/elections/:electionId/open-vote",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const el=(await query(`SELECT * FROM elections WHERE id=$1 AND world_id=$2`,[req.params.electionId,req.params.worldId])).rows[0];
    if(!el)return res.status(404).json({error:"Election introuvable"});
    await query(`UPDATE elections SET status='voting' WHERE id=$1`,[el.id]);
    await emitNews(req.params.worldId,"politics",`Le vote est ouvert`,{electionId:el.id});
    res.json({ok:true});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/elections/:electionId/vote",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({candidateUserId:z.number().int().positive()}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Vote invalide"});
    const el=(await query(`SELECT * FROM elections WHERE id=$1 AND world_id=$2`,[req.params.electionId,req.params.worldId])).rows[0];
    if(!el||el.status!=="voting")return res.status(409).json({error:"Vote fermé"});
    const cand=(await query(`SELECT * FROM election_candidates WHERE election_id=$1 AND user_id=$2`,[el.id,parsed.data.candidateUserId])).rows[0];
    if(!cand)return res.status(400).json({error:"Candidat invalide"});
    await query(`INSERT INTO election_votes(election_id,voter_user_id,candidate_user_id)
                 VALUES ($1,$2,$3)
                 ON CONFLICT (election_id,voter_user_id) DO UPDATE SET candidate_user_id=EXCLUDED.candidate_user_id`,
      [el.id,req.user.id,parsed.data.candidateUserId]);
    res.json({ok:true});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/elections/:electionId/close",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const el=(await query(`SELECT * FROM elections WHERE id=$1 AND world_id=$2 FOR UPDATE`,[req.params.electionId,req.params.worldId])).rows[0];
    if(!el||el.status!=="voting")return res.status(409).json({error:"Election non clôturable"});
    const result=(await query(`
      SELECT candidate_user_id,COUNT(*)::int AS votes
      FROM election_votes WHERE election_id=$1
      GROUP BY candidate_user_id ORDER BY votes DESC,candidate_user_id ASC LIMIT 1
    `,[el.id])).rows[0];
    if(!result)return res.status(409).json({error:"Aucun vote"});
    await withTransaction(async c=>{
      await c.query(`UPDATE elections SET status='closed',winner_user_id=$1 WHERE id=$2`,[result.candidate_user_id,el.id]);
      await c.query(`
        INSERT INTO offices(world_id,entity_id,office_type,holder_user_id,mandate_start,mandate_end)
        VALUES ($1,$2,$3,$4,NOW(),NOW()+INTERVAL '30 days')
        ON CONFLICT (world_id,entity_id,office_type)
        DO UPDATE SET holder_user_id=EXCLUDED.holder_user_id,mandate_start=EXCLUDED.mandate_start,mandate_end=EXCLUDED.mandate_end
      `,[req.params.worldId,el.entity_id,el.office_type,result.candidate_user_id]);
    });
    const winner=(await query(`SELECT username FROM users WHERE id=$1`,[result.candidate_user_id])).rows[0];
    const ent=(await query(`SELECT name FROM public_entities WHERE id=$1`,[el.entity_id])).rows[0];
    await emitNews(req.params.worldId,"politics",`${winner.username} élu à ${ent.name}`,{electionId:el.id,votes:result.votes});
    await notify(result.candidate_user_id,req.params.worldId,"Victoire électorale",`Vous avez été élu à ${ent.name}.`);
    res.json({ok:true,winnerUserId:result.candidate_user_id,votes:result.votes});
  }catch(e){next(e);}
});

// ===== POLICIES WITH REAL EFFECTS =====
app.post("/api/world/:worldId/politics/policies/:policyId/activate",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const p=(await query(`SELECT p.*,pe.entity_type,pe.name FROM policies p JOIN public_entities pe ON pe.id=p.entity_id WHERE p.id=$1 AND p.world_id=$2`,
      [req.params.policyId,req.params.worldId])).rows[0];
    if(!p)return res.status(404).json({error:"Mesure introuvable"});
    const office=await getOfficeForUser(req.user.id,req.params.worldId,p.entity_id);
    if(!office)return res.status(403).json({error:"Vous ne dirigez pas ce territoire"});
    await withTransaction(async c=>{
      if(p.policy_type==="subsidy"||p.policy_type==="infrastructure"||p.policy_type==="public_contract"){
        const ent=(await c.query(`SELECT treasury FROM public_entities WHERE id=$1 FOR UPDATE`,[p.entity_id])).rows[0];
        if(Number(ent.treasury)<Number(p.amount))throw Object.assign(new Error("Budget public insuffisant"),{status:409});
        await c.query(`UPDATE public_entities SET treasury=treasury-$1 WHERE id=$2`,[p.amount,p.entity_id]);
      }
      if(p.policy_type==="tax"){
        const effect=p.effect_json||{};
        const rate=Number(effect.businessTax ?? 0.04);
        await c.query(`UPDATE public_entities SET tax_business=$1 WHERE id=$2`,[rate,p.entity_id]);
      }
      await c.query(`UPDATE policies SET status='active',starts_at=NOW() WHERE id=$1`,[p.id]);
    });
    await emitNews(req.params.worldId,"politics",`${p.title} entre en vigueur à ${p.name}`,{policyId:p.id,type:p.policy_type});
    res.json({ok:true});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== CONTRACTS BIDS & AWARD =====
app.post("/api/world/:worldId/contracts/:contractId/bids",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({amount:z.number().int().min(1),message:z.string().max(1000).default("")}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Offre invalide"});
    const ct=(await query(`SELECT * FROM contracts WHERE id=$1 AND world_id=$2`,[req.params.contractId,req.params.worldId])).rows[0];
    if(!ct||ct.status!=="open")return res.status(409).json({error:"Contrat fermé"});
    await query(`INSERT INTO contract_bids(contract_id,bidder_user_id,amount,message)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (contract_id,bidder_user_id) DO UPDATE SET amount=EXCLUDED.amount,message=EXCLUDED.message,created_at=NOW()`,
      [ct.id,req.user.id,parsed.data.amount,parsed.data.message]);
    await notify(ct.issuer_user_id,req.params.worldId,"Nouvelle offre",`Une offre de ${parsed.data.amount} € a été déposée sur "${ct.title}".`);
    res.json({ok:true});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/contracts/:contractId/award",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({bidderUserId:z.number().int().positive()}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Attribution invalide"});
    const ct=(await query(`SELECT * FROM contracts WHERE id=$1 AND world_id=$2`,[req.params.contractId,req.params.worldId])).rows[0];
    if(!ct||ct.issuer_user_id!==req.user.id)return res.status(403).json({error:"Non autorisé"});
    const bid=(await query(`SELECT * FROM contract_bids WHERE contract_id=$1 AND bidder_user_id=$2`,[ct.id,parsed.data.bidderUserId])).rows[0];
    if(!bid)return res.status(404).json({error:"Offre introuvable"});
    await query(`UPDATE contracts SET status='awarded',awarded_bidder_user_id=$1,awarded_amount=$2 WHERE id=$3`,
      [bid.bidder_user_id,bid.amount,ct.id]);
    await emitNews(req.params.worldId,"economy",`Contrat attribué : ${ct.title}`,{contractId:ct.id,amount:bid.amount});
    await notify(bid.bidder_user_id,req.params.worldId,"Contrat remporté",`Vous avez remporté "${ct.title}" pour ${bid.amount} €.`);
    res.json({ok:true});
  }catch(e){next(e);}
});

// ===== REPAIR ORDERS FLOW =====
app.post("/api/world/:worldId/garage/:vehicleId/repair-request",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({description:z.string().min(5).max(1000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Demande invalide"});
    const v=(await query(`SELECT * FROM vehicles WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,[req.params.vehicleId,req.user.id,req.params.worldId])).rows[0];
    if(!v)return res.status(404).json({error:"Véhicule introuvable"});
    const ro=(await query(`
      INSERT INTO repair_orders(world_id,vehicle_id,customer_user_id,description,status)
      VALUES ($1,$2,$3,$4,'requested') RETURNING *
    `,[req.params.worldId,v.id,req.user.id,parsed.data.description])).rows[0];
    await emitNews(req.params.worldId,"automotive",`Nouvelle demande de réparation`,{repairOrderId:ro.id,vehicleId:v.id});
    res.status(201).json({repairOrder:ro});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/repairs/:repairId/quote",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({cost:z.number().int().min(1).max(10000000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Devis invalide"});
    const ownedGarage=(await query(`SELECT id FROM companies WHERE owner_user_id=$1 AND world_id=$2 AND company_type='garage' LIMIT 1`,
      [req.user.id,req.params.worldId])).rows[0];
    if(!ownedGarage)return res.status(403).json({error:"Vous devez posséder un garage"});
    const ro=(await query(`UPDATE repair_orders SET garage_company_id=$1,quoted_by_user_id=$2,estimated_cost=$3,status='quoted'
      WHERE id=$4 AND world_id=$5 AND status='requested' RETURNING *`,
      [ownedGarage.id,req.user.id,parsed.data.cost,req.params.repairId,req.params.worldId])).rows[0];
    if(!ro)return res.status(409).json({error:"Demande indisponible"});
    await notify(ro.customer_user_id,req.params.worldId,"Devis reçu",`Un garage propose ${parsed.data.cost} € pour votre réparation.`);
    res.json({repairOrder:ro});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/repairs/:repairId/accept",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const ro=(await query(`SELECT * FROM repair_orders WHERE id=$1 AND world_id=$2`,[req.params.repairId,req.params.worldId])).rows[0];
    if(!ro||ro.customer_user_id!==req.user.id||ro.status!=="quoted")return res.status(409).json({error:"Devis indisponible"});
    await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<Number(ro.estimated_cost))throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      const nb=Number(w.euros)-Number(ro.estimated_cost);
      await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,[nb,req.user.id]);
      await c.query(`UPDATE repair_orders SET status='completed',final_cost=$1 WHERE id=$2`,[ro.estimated_cost,ro.id]);
      await c.query(`UPDATE vehicles SET condition=LEAST(100,condition+25),status='garage' WHERE id=$1`,[ro.vehicle_id]);
      const garage=(await c.query(`SELECT owner_user_id FROM companies WHERE id=$1`,[ro.garage_company_id])).rows[0];
      if(garage){
        const gw=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[garage.owner_user_id])).rows[0];
        const gb=Number(gw.euros)+Number(ro.estimated_cost);
        await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,[gb,garage.owner_user_id]);
      }
    });
    await emitNews(req.params.worldId,"automotive","Réparation terminée",{repairOrderId:ro.id,vehicleId:ro.vehicle_id});
    res.json({ok:true});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== RENTAL FLOW =====
app.post("/api/world/:worldId/garage/:vehicleId/rental-list",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({dailyPrice:z.number().int().min(10),deposit:z.number().int().min(0).default(0)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Tarif invalide"});
    const v=(await query(`SELECT * FROM vehicles WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,[req.params.vehicleId,req.user.id,req.params.worldId])).rows[0];
    if(!v)return res.status(404).json({error:"Véhicule introuvable"});
    const r=(await query(`
      INSERT INTO rentals(world_id,vehicle_id,owner_user_id,daily_price,deposit,status)
      VALUES ($1,$2,$3,$4,$5,'available') RETURNING *
    `,[req.params.worldId,v.id,req.user.id,parsed.data.dailyPrice,parsed.data.deposit])).rows[0];
    await query(`UPDATE vehicles SET status='rented' WHERE id=$1`,[v.id]);
    res.status(201).json({rental:r});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/rentals/:rentalId/start",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const r=(await query(`SELECT * FROM rentals WHERE id=$1 AND world_id=$2 FOR UPDATE`,[req.params.rentalId,req.params.worldId])).rows[0];
    if(!r||r.status!=="available")return res.status(409).json({error:"Location indisponible"});
    if(r.owner_user_id===req.user.id)return res.status(400).json({error:"Vous ne pouvez pas louer votre propre véhicule"});
    await withTransaction(async c=>{
      const total=Number(r.daily_price)+Number(r.deposit);
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<total)throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[total,req.user.id]);
      await c.query(`UPDATE rentals SET renter_user_id=$1,start_at=NOW(),status='active',total_charged=$2 WHERE id=$3`,
        [req.user.id,total,r.id]);
      const ow=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[r.owner_user_id])).rows[0];
      await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,[Number(ow.euros)+Number(r.daily_price),r.owner_user_id]);
    });
    await emitNews(req.params.worldId,"automotive","Un véhicule vient d'être loué",{rentalId:r.id});
    res.json({ok:true});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});
app.post("/api/world/:worldId/rentals/:rentalId/end",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const r=(await query(`SELECT * FROM rentals WHERE id=$1 AND world_id=$2`,[req.params.rentalId,req.params.worldId])).rows[0];
    if(!r||r.status!=="active"||r.renter_user_id!==req.user.id)return res.status(409).json({error:"Location invalide"});
    await withTransaction(async c=>{
      await c.query(`UPDATE rentals SET status='completed',end_at=NOW() WHERE id=$1`,[r.id]);
      await c.query(`UPDATE vehicles SET status='garage',mileage=mileage+150,condition=GREATEST(0,condition-1) WHERE id=$1`,[r.vehicle_id]);
      if(Number(r.deposit)>0){
        const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
        await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,[Number(w.euros)+Number(r.deposit),req.user.id]);
      }
    });
    res.json({ok:true});
  }catch(e){next(e);}
});

// ===== COURT JUDGMENT -> ENFORCEMENT =====
app.post("/api/world/:worldId/justice/cases/:caseId/judgment",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      winnerUserId:z.number().int().positive(),
      amountAwarded:z.number().int().min(0),
      decision:z.string().min(10).max(5000),
      executable:z.boolean().default(true)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Jugement invalide"});
    const c=(await query(`SELECT * FROM court_cases WHERE id=$1 AND world_id=$2`,[req.params.caseId,req.params.worldId])).rows[0];
    if(!c)return res.status(404).json({error:"Dossier introuvable"});
    // Prototype permission: judge must be assigned to the case.
    if(c.judge_user_id!==req.user.id)return res.status(403).json({error:"Vous n'êtes pas le juge assigné"});
    const debtor=parsed.data.winnerUserId===c.plaintiff_user_id?c.defendant_user_id:c.plaintiff_user_id;
    const j=(await query(`
      INSERT INTO judgments(case_id,judge_user_id,winner_user_id,amount_awarded,decision,executable,debtor_user_id,creditor_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$3)
      ON CONFLICT (case_id) DO UPDATE SET winner_user_id=EXCLUDED.winner_user_id,amount_awarded=EXCLUDED.amount_awarded,
      decision=EXCLUDED.decision,executable=EXCLUDED.executable,debtor_user_id=EXCLUDED.debtor_user_id,creditor_user_id=EXCLUDED.creditor_user_id
      RETURNING *
    `,[c.id,req.user.id,parsed.data.winnerUserId,parsed.data.amountAwarded,parsed.data.decision,parsed.data.executable,debtor])).rows[0];
    await query(`UPDATE court_cases SET status='judged' WHERE id=$1`,[c.id]);
    if(j.executable&&j.amount_awarded>0&&debtor){
      await query(`
        INSERT INTO enforcement_orders(world_id,judgment_id,creditor_user_id,debtor_user_id,amount_total,status)
        VALUES ($1,$2,$3,$4,$5,'open')
      `,[req.params.worldId,j.id,j.creditor_user_id,j.debtor_user_id,j.amount_awarded]);
    }
    await emitNews(req.params.worldId,"justice",`Jugement rendu dans l'affaire #${c.id}`,{caseId:c.id,amount:j.amount_awarded});
    res.json({judgment:j});
  }catch(e){next(e);}
});
app.post("/api/world/:worldId/enforcement/:orderId/bank-seizure",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const order=(await query(`SELECT * FROM enforcement_orders WHERE id=$1 AND world_id=$2 FOR UPDATE`,[req.params.orderId,req.params.worldId])).rows[0];
    if(!order)return res.status(404).json({error:"Ordre introuvable"});
    if(order.bailiff_user_id && order.bailiff_user_id!==req.user.id)return res.status(403).json({error:"Ordre attribué à un autre huissier"});
    const bailiffCo=(await query(`SELECT id FROM companies WHERE owner_user_id=$1 AND world_id=$2 AND company_type='bailiff_office' LIMIT 1`,
      [req.user.id,req.params.worldId])).rows[0];
    if(!bailiffCo)return res.status(403).json({error:"Vous devez posséder une étude d'huissier"});
    const recovered=await withTransaction(async c=>{
      await c.query(`UPDATE enforcement_orders SET bailiff_user_id=$1 WHERE id=$2 AND bailiff_user_id IS NULL`,[req.user.id,order.id]);
      const dw=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[order.debtor_user_id])).rows[0];
      const cw=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[order.creditor_user_id])).rows[0];
      const remaining=Number(order.amount_total)-Number(order.amount_recovered);
      const take=Math.max(0,Math.min(Number(dw.euros),remaining));
      if(take<=0)return 0;
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[take,order.debtor_user_id]);
      await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[take,order.creditor_user_id]);
      const total=Number(order.amount_recovered)+take;
      await c.query(`UPDATE enforcement_orders SET amount_recovered=$1,status=$2 WHERE id=$3`,
        [total,total>=Number(order.amount_total)?'completed':'partial',order.id]);
      await c.query(`INSERT INTO enforcement_actions(order_id,action_type,amount) VALUES ($1,'bank_seizure',$2)`,[order.id,take]);
      return take;
    });
    await emitNews(req.params.worldId,"justice",`Saisie bancaire exécutée`,{orderId:order.id,amount:recovered});
    res.json({ok:true,recovered});
  }catch(e){next(e);}
});

// ===== LOAN REPAYMENT =====
app.post("/api/world/:worldId/loans/:loanId/pay",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const loan=(await query(`SELECT * FROM loans WHERE id=$1 AND borrower_user_id=$2 AND world_id=$3`,
      [req.params.loanId,req.user.id,req.params.worldId])).rows[0];
    if(!loan||!['active','approved'].includes(loan.status))return res.status(409).json({error:"Crédit non payable"});
    const payment=Math.min(Number(loan.monthly_payment||Math.ceil(Number(loan.principal)/Number(loan.term_months))),Number(loan.balance));
    await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<payment)throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[payment,req.user.id]);
      const nb=Number(loan.balance)-payment;
      await c.query(`UPDATE loans SET balance=$1,status=$2,next_payment_at=NOW()+INTERVAL '1 month' WHERE id=$3`,
        [nb,nb<=0?'repaid':'active',loan.id]);
    });
    res.json({ok:true,payment});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== WORLD DAILY TICK =====
app.post("/api/admin/world/:worldId/daily-tick",async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    if(!['beta','world1'].includes(worldId))return res.status(400).json({error:"Monde invalide"});
    await withTransaction(async c=>{
      await c.query(`UPDATE world_clock SET game_day=game_day+1,last_tick_at=NOW() WHERE world_id=$1`,[worldId]);
      await c.query(`UPDATE world_profiles SET game_day=game_day+1 WHERE world_id=$1`,[worldId]);
      await c.query(`UPDATE vehicles SET estimated_value=GREATEST(500,ROUND(estimated_value*0.999)::bigint) WHERE world_id=$1`,[worldId]);

      // Matières premières : variation quotidienne contrôlée
      await c.query(`
        UPDATE raw_materials
        SET current_price=GREATEST(1,ROUND(
          current_price * (1 + ((RANDOM()-0.5)*2*volatility))
        )::bigint)
      `);

      // Salaires des entreprises
      const companies=(await c.query(`SELECT id,owner_user_id FROM companies WHERE world_id=$1`,[worldId])).rows;
      for(const co of companies){
        await c.query(`
          INSERT INTO company_financials(company_id)
          VALUES ($1) ON CONFLICT(company_id) DO NOTHING
        `,[co.id]);

        const payrollRow=(await c.query(`
          SELECT COALESCE(SUM(salary_daily),0)::bigint AS payroll
          FROM employees WHERE company_id=$1 AND active=TRUE
        `,[co.id])).rows[0];
        const payroll=Number(payrollRow.payroll||0);

        if(payroll>0){
          const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[co.owner_user_id])).rows[0];
          const available=Number(w?.euros||0);
          const paid=Math.min(available,payroll);
          if(paid>0) await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[paid,co.owner_user_id]);
          const unpaid=payroll-paid;
          await c.query(`UPDATE company_financials SET unpaid_wages=unpaid_wages+$1 WHERE company_id=$2`,[unpaid,co.id]);
        }

        // Taxe quotidienne simplifiée basée sur la fiscalité locale
        const territory=(await c.query(`
          SELECT pe.id,pe.tax_business
          FROM public_entities pe
          WHERE pe.world_id=$1 AND pe.entity_type='city' AND pe.name=(SELECT city FROM companies WHERE id=$2)
          LIMIT 1
        `,[worldId,co.id])).rows[0];
        if(territory){
          const tax=Math.max(0,Math.round(Number(co.cash||0)*Number(territory.tax_business)/30));
          if(tax>0){
            await c.query(`
              INSERT INTO tax_assessments(world_id,company_id,public_entity_id,tax_type,amount,due_at)
              VALUES ($1,$2,$3,'business',$4,NOW()+INTERVAL '7 days')
            `,[worldId,co.id,territory.id,tax]);
            await c.query(`UPDATE company_financials SET unpaid_taxes=unpaid_taxes+$1 WHERE company_id=$2`,[tax,co.id]);
          }
        }

        await updateCompanySolvency(c,co.id);
      }

      // Taxes échues
      await c.query(`UPDATE tax_assessments SET status='overdue' WHERE world_id=$1 AND status='due' AND due_at<NOW()`,[worldId]);

      // Economie territoriale
      const terrs=(await c.query(`
        SELECT pe.id,
          (SELECT COUNT(*) FROM companies cc WHERE cc.world_id=$1 AND cc.city=pe.name) AS companies_count,
          (SELECT COUNT(*) FROM employees e JOIN companies c2 ON c2.id=e.company_id WHERE e.active=TRUE AND c2.world_id=$1 AND c2.city=pe.name) AS jobs
        FROM public_entities pe WHERE pe.world_id=$1
      `,[worldId])).rows;
      for(const t of terrs){
        const companiesCount=Number(t.companies_count||0);
        const jobs=Number(t.jobs||0);
        const eco=100 + companiesCount*0.8 + jobs*0.02;
        const employment=Math.min(0.99,0.75+jobs/200000);
        await c.query(`
          INSERT INTO territory_metrics(entity_id,economic_index,employment_rate,vehicle_demand_index,logistics_index,industry_index,last_update_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT(entity_id) DO UPDATE SET
            economic_index=EXCLUDED.economic_index,
            employment_rate=EXCLUDED.employment_rate,
            vehicle_demand_index=EXCLUDED.vehicle_demand_index,
            logistics_index=EXCLUDED.logistics_index,
            industry_index=EXCLUDED.industry_index,
            last_update_at=NOW()
        `,[t.id,eco,employment,100+companiesCount*0.5,100+companiesCount*0.4,100+companiesCount*0.6]);
      }

      // Clôture automatique des appels d'offres arrivés à échéance
      await c.query(`UPDATE public_tenders SET status='evaluating'
        WHERE world_id=$1 AND status='open' AND closes_at<=NOW()`,[worldId]);

    });
    await emitNews(worldId,"world","Mise à jour quotidienne effectuée",{});
    res.json({ok:true});
  }catch(e){next(e);}
});



// ===== ROLES / PERMISSIONS =====
app.get("/api/world/:worldId/roles/me",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT role,world_id,created_at FROM user_roles
      WHERE user_id=$1 AND (world_id=$2 OR world_id IS NULL)
      ORDER BY role
    `,[req.user.id,req.params.worldId]);
    res.json({roles:rows});
  }catch(e){next(e);}
});

app.post("/api/admin/world/:worldId/roles/grant",adminKeyRequired,async(req,res,next)=>{
  try{
    const parsed=z.object({
      username:z.string().min(3).max(24),
      role:z.enum(['admin','moderator','judge','journalist','editor_in_chief','lawyer','bailiff','banker','mayor','regional_president','president'])
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Données invalides"});
    const u=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[parsed.data.username])).rows[0];
    if(!u)return res.status(404).json({error:"Utilisateur introuvable"});
    await query(`
      INSERT INTO user_roles(user_id,world_id,role)
      VALUES ($1,$2,$3)
      ON CONFLICT (user_id,world_id,role) DO NOTHING
    `,[u.id,req.params.worldId,parsed.data.role]);
    broadcast(req.params.worldId,"role_granted",{userId:u.id,role:parsed.data.role});
    res.json({ok:true});
  }catch(e){next(e);}
});

// ===== JUDGE ASSIGNMENT =====
app.post("/api/world/:worldId/justice/cases/:caseId/assign-judge",
  authRequired,requireRoles(['admin','judge']),actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({judgeUsername:z.string().min(3).max(24)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Données invalides"});
    const u=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[parsed.data.judgeUsername])).rows[0];
    if(!u)return res.status(404).json({error:"Juge introuvable"});
    if(!(await hasRole(u.id,req.params.worldId,['judge','admin'])))return res.status(403).json({error:"Ce joueur n'est pas juge"});
    const c=(await query(`UPDATE court_cases SET judge_user_id=$1,status='scheduled' WHERE id=$2 AND world_id=$3 RETURNING *`,
      [u.id,req.params.caseId,req.params.worldId])).rows[0];
    if(!c)return res.status(404).json({error:"Dossier introuvable"});
    await notify(u.id,req.params.worldId,"Audience assignée",`Vous êtes juge sur l'affaire #${c.id}.`);
    broadcast(req.params.worldId,"court_case_update",{caseId:c.id,status:"scheduled"});
    res.json({case:c});
  }catch(e){next(e);}
});

// ===== JUDICIAL AUCTIONS =====
app.post("/api/world/:worldId/enforcement/:orderId/seize-vehicle",
  authRequired,requireRoles(['bailiff','admin']),actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({vehicleId:z.number().int().positive(),startingPrice:z.number().int().min(500)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Saisie invalide"});
    const order=(await query(`SELECT * FROM enforcement_orders WHERE id=$1 AND world_id=$2`,[req.params.orderId,req.params.worldId])).rows[0];
    if(!order)return res.status(404).json({error:"Ordre introuvable"});
    if(order.status==="completed")return res.status(409).json({error:"Ordre déjà exécuté"});
    const v=(await query(`SELECT * FROM vehicles WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [parsed.data.vehicleId,order.debtor_user_id,req.params.worldId])).rows[0];
    if(!v)return res.status(404).json({error:"Véhicule saisissable introuvable"});
    const auction=await withTransaction(async c=>{
      await c.query(`UPDATE vehicles SET status='seized' WHERE id=$1`,[v.id]);
      await c.query(`INSERT INTO enforcement_actions(order_id,action_type,vehicle_id) VALUES ($1,'vehicle_seizure',$2)`,
        [order.id,v.id]);
      const ar=await c.query(`
        INSERT INTO judicial_auctions(world_id,enforcement_order_id,vehicle_id,starting_price,status,opens_at,closes_at)
        VALUES ($1,$2,$3,$4,'scheduled',NOW()+INTERVAL '5 minutes',NOW()+INTERVAL '24 hours')
        RETURNING *
      `,[req.params.worldId,order.id,v.id,parsed.data.startingPrice]);
      return ar.rows[0];
    });
    await broadcastNews(req.params.worldId,"justice",`Véhicule #${v.id} saisi et placé aux enchères`,{auctionId:auction.id});
    res.status(201).json({auction});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/auctions",authRequired,async(req,res,next)=>{
  try{
    await query(`UPDATE judicial_auctions SET status='open'
      WHERE world_id=$1 AND status='scheduled' AND opens_at<=NOW()`,[req.params.worldId]);
    const {rows}=await query(`
      SELECT a.*,v.make,v.model,v.year,v.mileage,v.condition,u.username AS highest_bidder
      FROM judicial_auctions a
      JOIN vehicles v ON v.id=a.vehicle_id
      LEFT JOIN users u ON u.id=a.highest_bidder_user_id
      WHERE a.world_id=$1 AND a.status IN ('scheduled','open')
      ORDER BY a.closes_at ASC
    `,[req.params.worldId]);
    res.json({auctions:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/auctions/:auctionId/bid",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({amount:z.number().int().min(500)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Enchère invalide"});
    const result=await withTransaction(async c=>{
      const ar=(await c.query(`SELECT * FROM judicial_auctions WHERE id=$1 AND world_id=$2 FOR UPDATE`,
        [req.params.auctionId,req.params.worldId])).rows[0];
      if(!ar||ar.status!=="open"||new Date(ar.closes_at)<=new Date())
        throw Object.assign(new Error("Enchère fermée"),{status:409});
      const min=Math.max(Number(ar.starting_price),Number(ar.highest_bid)+100);
      if(parsed.data.amount<min)throw Object.assign(new Error(`Enchère minimale : ${min} €`),{status:409});
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<parsed.data.amount)throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      await c.query(`
        INSERT INTO judicial_bids(auction_id,bidder_user_id,amount)
        VALUES ($1,$2,$3)
        ON CONFLICT (auction_id,bidder_user_id)
        DO UPDATE SET amount=EXCLUDED.amount,created_at=NOW()
      `,[ar.id,req.user.id,parsed.data.amount]);
      await c.query(`UPDATE judicial_auctions SET highest_bid=$1,highest_bidder_user_id=$2 WHERE id=$3`,
        [parsed.data.amount,req.user.id,ar.id]);
      return {auctionId:ar.id,amount:parsed.data.amount};
    });
    broadcast(req.params.worldId,"auction_bid",result);
    res.json({ok:true,...result});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.post("/api/admin/world/:worldId/auctions/:auctionId/close",adminKeyRequired,async(req,res,next)=>{
  try{
    const result=await withTransaction(async c=>{
      const a=(await c.query(`SELECT * FROM judicial_auctions WHERE id=$1 AND world_id=$2 FOR UPDATE`,
        [req.params.auctionId,req.params.worldId])).rows[0];
      if(!a||a.status==="closed")throw Object.assign(new Error("Enchère invalide"),{status:409});
      if(!a.highest_bidder_user_id){
        await c.query(`UPDATE judicial_auctions SET status='closed' WHERE id=$1`,[a.id]);
        return {sold:false,auctionId:a.id};
      }
      const bw=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[a.highest_bidder_user_id])).rows[0];
      if(Number(bw.euros)<Number(a.highest_bid))throw Object.assign(new Error("Gagnant insolvable"),{status:409});
      const order=(await c.query(`SELECT * FROM enforcement_orders WHERE id=$1 FOR UPDATE`,[a.enforcement_order_id])).rows[0];
      const take=Number(a.highest_bid);
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[take,a.highest_bidder_user_id]);
      await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[take,order.creditor_user_id]);
      await c.query(`UPDATE vehicles SET owner_user_id=$1,status='garage' WHERE id=$2`,[a.highest_bidder_user_id,a.vehicle_id]);
      await c.query(`UPDATE judicial_auctions SET status='closed' WHERE id=$1`,[a.id]);
      const total=Number(order.amount_recovered)+take;
      await c.query(`UPDATE enforcement_orders SET amount_recovered=$1,status=$2 WHERE id=$3`,
        [total,total>=Number(order.amount_total)?'completed':'partial',order.id]);
      await c.query(`INSERT INTO enforcement_actions(order_id,action_type,amount,vehicle_id)
        VALUES ($1,'asset_sale',$2,$3)`,[order.id,take,a.vehicle_id]);
      return {sold:true,auctionId:a.id,bidderUserId:a.highest_bidder_user_id,amount:take,vehicleId:a.vehicle_id};
    });
    await broadcastNews(req.params.worldId,"justice",
      result.sold?`Vente judiciaire conclue à ${result.amount} €`:"Enchère judiciaire clôturée sans offre",result);
    res.json({ok:true,...result});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== SECURE MIDNIGHT TICK =====
app.post("/api/cron/world/:worldId/daily-tick",cronSecretRequired,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    if(!['beta','world1'].includes(worldId))return res.status(400).json({error:"Monde invalide"});
    const result=await withTransaction(async c=>{
      const wc=(await c.query(`SELECT * FROM world_clock WHERE world_id=$1 FOR UPDATE`,[worldId])).rows[0];
      const today=new Date().toISOString().slice(0,10);
      const last=new Date(wc.last_tick_at).toISOString().slice(0,10);
      if(today===last)return {alreadyDone:true,day:wc.game_day};
      const upd=(await c.query(`UPDATE world_clock SET game_day=game_day+1,last_tick_at=NOW() WHERE world_id=$1 RETURNING game_day`,[worldId])).rows[0];
      await c.query(`UPDATE world_profiles SET game_day=$1 WHERE world_id=$2`,[upd.game_day,worldId]);
      await c.query(`UPDATE vehicles SET estimated_value=GREATEST(500,ROUND(estimated_value*0.999)::bigint) WHERE world_id=$1`,[worldId]);

      // Matières premières : variation quotidienne contrôlée
      await c.query(`
        UPDATE raw_materials
        SET current_price=GREATEST(1,ROUND(
          current_price * (1 + ((RANDOM()-0.5)*2*volatility))
        )::bigint)
      `);

      // Salaires des entreprises
      const companies=(await c.query(`SELECT id,owner_user_id FROM companies WHERE world_id=$1`,[worldId])).rows;
      for(const co of companies){
        await c.query(`
          INSERT INTO company_financials(company_id)
          VALUES ($1) ON CONFLICT(company_id) DO NOTHING
        `,[co.id]);

        const payrollRow=(await c.query(`
          SELECT COALESCE(SUM(salary_daily),0)::bigint AS payroll
          FROM employees WHERE company_id=$1 AND active=TRUE
        `,[co.id])).rows[0];
        const payroll=Number(payrollRow.payroll||0);

        if(payroll>0){
          const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[co.owner_user_id])).rows[0];
          const available=Number(w?.euros||0);
          const paid=Math.min(available,payroll);
          if(paid>0) await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[paid,co.owner_user_id]);
          const unpaid=payroll-paid;
          await c.query(`UPDATE company_financials SET unpaid_wages=unpaid_wages+$1 WHERE company_id=$2`,[unpaid,co.id]);
        }

        // Taxe quotidienne simplifiée basée sur la fiscalité locale
        const territory=(await c.query(`
          SELECT pe.id,pe.tax_business
          FROM public_entities pe
          WHERE pe.world_id=$1 AND pe.entity_type='city' AND pe.name=(SELECT city FROM companies WHERE id=$2)
          LIMIT 1
        `,[worldId,co.id])).rows[0];
        if(territory){
          const tax=Math.max(0,Math.round(Number(co.cash||0)*Number(territory.tax_business)/30));
          if(tax>0){
            await c.query(`
              INSERT INTO tax_assessments(world_id,company_id,public_entity_id,tax_type,amount,due_at)
              VALUES ($1,$2,$3,'business',$4,NOW()+INTERVAL '7 days')
            `,[worldId,co.id,territory.id,tax]);
            await c.query(`UPDATE company_financials SET unpaid_taxes=unpaid_taxes+$1 WHERE company_id=$2`,[tax,co.id]);
          }
        }

        await updateCompanySolvency(c,co.id);
      }

      // Taxes échues
      await c.query(`UPDATE tax_assessments SET status='overdue' WHERE world_id=$1 AND status='due' AND due_at<NOW()`,[worldId]);

      // Economie territoriale
      const terrs=(await c.query(`
        SELECT pe.id,
          (SELECT COUNT(*) FROM companies cc WHERE cc.world_id=$1 AND cc.city=pe.name) AS companies_count,
          (SELECT COUNT(*) FROM employees e JOIN companies c2 ON c2.id=e.company_id WHERE e.active=TRUE AND c2.world_id=$1 AND c2.city=pe.name) AS jobs
        FROM public_entities pe WHERE pe.world_id=$1
      `,[worldId])).rows;
      for(const t of terrs){
        const companiesCount=Number(t.companies_count||0);
        const jobs=Number(t.jobs||0);
        const eco=100 + companiesCount*0.8 + jobs*0.02;
        const employment=Math.min(0.99,0.75+jobs/200000);
        await c.query(`
          INSERT INTO territory_metrics(entity_id,economic_index,employment_rate,vehicle_demand_index,logistics_index,industry_index,last_update_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT(entity_id) DO UPDATE SET
            economic_index=EXCLUDED.economic_index,
            employment_rate=EXCLUDED.employment_rate,
            vehicle_demand_index=EXCLUDED.vehicle_demand_index,
            logistics_index=EXCLUDED.logistics_index,
            industry_index=EXCLUDED.industry_index,
            last_update_at=NOW()
        `,[t.id,eco,employment,100+companiesCount*0.5,100+companiesCount*0.4,100+companiesCount*0.6]);
      }

      // Clôture automatique des appels d'offres arrivés à échéance
      await c.query(`UPDATE public_tenders SET status='evaluating'
        WHERE world_id=$1 AND status='open' AND closes_at<=NOW()`,[worldId]);

      await c.query(`UPDATE vehicles SET mileage=mileage+80,condition=GREATEST(0,condition-1)
        WHERE world_id=$1 AND status='rented'`,[worldId]);
      await c.query(`UPDATE loans SET status='defaulted'
        WHERE world_id=$1 AND status='active' AND next_payment_at IS NOT NULL AND next_payment_at < NOW()-INTERVAL '30 days'`,[worldId]);
      await c.query(`UPDATE judicial_auctions SET status='open'
        WHERE world_id=$1 AND status='scheduled' AND opens_at<=NOW()`,[worldId]);
      return {alreadyDone:false,day:upd.game_day};
    });
    if(!result.alreadyDone){
      await broadcastNews(worldId,"world",`Jour ${result.day} : mise à jour de minuit`,{day:result.day});
      broadcast(worldId,"daily_tick",{day:result.day});
    }
    res.json({ok:true,...result});
  }catch(e){next(e);}
});



// ===== INDUSTRIE / USINES =====
app.get("/api/world/:worldId/industry",authRequired,async(req,res,next)=>{
  try{
    const factories=(await query(`
      SELECT f.*,c.name AS company_name,c.company_type
      FROM factories f JOIN companies c ON c.id=f.company_id
      WHERE f.world_id=$1 ORDER BY f.created_at DESC
    `,[req.params.worldId])).rows;
    const blueprints=(await query(`
      SELECT vb.*,c.name AS manufacturer
      FROM vehicle_blueprints vb JOIN companies c ON c.id=vb.manufacturer_company_id
      WHERE vb.world_id=$1 ORDER BY vb.created_at DESC
    `,[req.params.worldId])).rows;
    const parts=(await query(`SELECT * FROM parts_catalog ORDER BY category,name`)).rows;
    res.json({factories,blueprints,parts});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/industry/factories",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      companyId:z.number().int().positive(),
      name:z.string().min(3).max(120),
      city:z.string().min(1).max(80),
      factoryType:z.enum(['vehicle','parts','engine','battery'])
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Usine invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [parsed.data.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Entreprise non autorisée"});
    const cost=500000;
    const f=await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<cost)throw Object.assign(new Error("500 000 € nécessaires"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[cost,req.user.id]);
      return (await c.query(`
        INSERT INTO factories(world_id,company_id,name,city,factory_type)
        VALUES ($1,$2,$3,$4,$5) RETURNING *
      `,[req.params.worldId,co.id,parsed.data.name,parsed.data.city,parsed.data.factoryType])).rows[0];
    });
    await broadcastNews(req.params.worldId,"industry",`Nouvelle usine : ${f.name}`,{factoryId:f.id});
    res.status(201).json({factory:f});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.post("/api/world/:worldId/industry/blueprints",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      companyId:z.number().int().positive(),
      make:z.string().min(2).max(80),
      model:z.string().min(1).max(80),
      vehicleType:z.enum(['car','van','truck','bus']),
      fuelType:z.enum(['petrol','diesel','hybrid','electric','hydrogen']),
      seats:z.number().int().min(1).max(100),
      payloadKg:z.number().int().min(0).max(50000),
      powerHp:z.number().int().min(20).max(2500),
      targetValue:z.number().int().min(1000).max(100000000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Plan véhicule invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3 AND company_type='manufacturer'`,
      [parsed.data.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Vous devez posséder un constructeur"});
    const b=(await query(`
      INSERT INTO vehicle_blueprints(world_id,manufacturer_company_id,make,model,vehicle_type,fuel_type,seats,payload_kg,power_hp,target_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `,[req.params.worldId,co.id,parsed.data.make,parsed.data.model,parsed.data.vehicleType,parsed.data.fuelType,
       parsed.data.seats,parsed.data.payloadKg,parsed.data.powerHp,parsed.data.targetValue])).rows[0];
    res.status(201).json({blueprint:b});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/industry/blueprints/:blueprintId/bom",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({parts:z.array(z.object({partId:z.number().int().positive(),quantity:z.number().int().min(1).max(100)})).min(1).max(30)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Nomenclature invalide"});
    const b=(await query(`
      SELECT vb.* FROM vehicle_blueprints vb JOIN companies c ON c.id=vb.manufacturer_company_id
      WHERE vb.id=$1 AND vb.world_id=$2 AND c.owner_user_id=$3
    `,[req.params.blueprintId,req.params.worldId,req.user.id])).rows[0];
    if(!b)return res.status(403).json({error:"Plan non autorisé"});
    await withTransaction(async c=>{
      await c.query(`DELETE FROM blueprint_parts WHERE blueprint_id=$1`,[b.id]);
      for(const p of parsed.data.parts){
        await c.query(`INSERT INTO blueprint_parts(blueprint_id,part_id,quantity) VALUES ($1,$2,$3)`,
          [b.id,p.partId,p.quantity]);
      }
    });
    res.json({ok:true});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/industry/factories/:factoryId/produce",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({blueprintId:z.number().int().positive(),quantity:z.number().int().min(1).max(100)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Ordre invalide"});
    const f=(await query(`
      SELECT f.*,c.owner_user_id FROM factories f JOIN companies c ON c.id=f.company_id
      WHERE f.id=$1 AND f.world_id=$2
    `,[req.params.factoryId,req.params.worldId])).rows[0];
    if(!f||f.owner_user_id!==req.user.id)return res.status(403).json({error:"Usine non autorisée"});
    const b=(await query(`SELECT * FROM vehicle_blueprints WHERE id=$1 AND world_id=$2`,
      [parsed.data.blueprintId,req.params.worldId])).rows[0];
    if(!b)return res.status(404).json({error:"Plan introuvable"});
    const bom=(await query(`
      SELECT bp.part_id,bp.quantity,pc.name FROM blueprint_parts bp
      JOIN parts_catalog pc ON pc.id=bp.part_id WHERE bp.blueprint_id=$1
    `,[b.id])).rows;
    if(!bom.length)return res.status(409).json({error:"Le plan ne contient aucune pièce"});
    const built=await withTransaction(async c=>{
      for(const p of bom){
        const inv=(await c.query(`SELECT quantity FROM part_inventory WHERE company_id=$1 AND part_id=$2 FOR UPDATE`,
          [f.company_id,p.part_id])).rows[0];
        const need=Number(p.quantity)*parsed.data.quantity;
        if(!inv||Number(inv.quantity)<need)throw Object.assign(new Error(`Stock insuffisant : ${p.name}`),{status:409});
      }
      for(const p of bom){
        await c.query(`UPDATE part_inventory SET quantity=quantity-$1 WHERE company_id=$2 AND part_id=$3`,
          [Number(p.quantity)*parsed.data.quantity,f.company_id,p.part_id]);
      }
      const order=(await c.query(`
        INSERT INTO production_orders(world_id,factory_id,blueprint_id,quantity,completed_quantity,status,completed_at)
        VALUES ($1,$2,$3,$4,$4,'completed',NOW()) RETURNING *
      `,[req.params.worldId,f.id,b.id,parsed.data.quantity])).rows[0];
      const vehicleIds=[];
      for(let n=0;n<parsed.data.quantity;n++){
        const vr=(await c.query(`
          INSERT INTO vehicles(world_id,owner_user_id,make,model,year,mileage,condition,estimated_value,status,
                               vehicle_type,fuel_type,seats,payload_kg,power_hp,purchase_price,rental_daily_price)
          VALUES ($1,$2,$3,$4,EXTRACT(YEAR FROM NOW())::int,0,100,$5,'garage',$6,$7,$8,$9,$10,$5,0)
          RETURNING id
        `,[req.params.worldId,req.user.id,b.make,b.model,b.target_value,b.vehicle_type,b.fuel_type,b.seats,b.payload_kg,b.power_hp])).rows[0];
        vehicleIds.push(vr.id);
      }
      return {order,vehicleIds};
    });
    await broadcastNews(req.params.worldId,"industry",`${parsed.data.quantity} ${b.make} ${b.model} sortent d'usine`,{factoryId:f.id});
    res.json({ok:true,...built});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.post("/api/world/:worldId/industry/inventory/buy",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({companyId:z.number().int().positive(),partId:z.number().int().positive(),quantity:z.number().int().min(1).max(10000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Achat invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [parsed.data.companyId,req.user.id,req.params.worldId])).rows[0];
    const part=(await query(`SELECT * FROM parts_catalog WHERE id=$1`,[parsed.data.partId])).rows[0];
    if(!co||!part)return res.status(404).json({error:"Entreprise ou pièce introuvable"});
    const cost=Number(part.base_value)*parsed.data.quantity;
    await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<cost)throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[cost,req.user.id]);
      await c.query(`
        INSERT INTO part_inventory(company_id,part_id,quantity) VALUES ($1,$2,$3)
        ON CONFLICT(company_id,part_id) DO UPDATE SET quantity=part_inventory.quantity+EXCLUDED.quantity
      `,[co.id,part.id,parsed.data.quantity]);
    });
    res.json({ok:true,cost});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== ASSURANCE / SINISTRES =====
app.get("/api/world/:worldId/insurance",authRequired,async(req,res,next)=>{
  try{
    const products=(await query(`
      SELECT ip.*,c.name AS insurer_name FROM insurance_products ip
      JOIN companies c ON c.id=ip.insurer_company_id
      WHERE ip.world_id=$1 AND ip.active=TRUE
    `,[req.params.worldId])).rows;
    const policies=(await query(`
      SELECT p.*,ip.name AS product_name,c.name AS insurer_name
      FROM insurance_policies p JOIN insurance_products ip ON ip.id=p.product_id
      JOIN companies c ON c.id=ip.insurer_company_id
      WHERE p.world_id=$1 AND p.holder_user_id=$2
    `,[req.params.worldId,req.user.id])).rows;
    res.json({products,policies});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/insurance/products",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      companyId:z.number().int().positive(),name:z.string().min(3).max(120),
      coverageType:z.enum(['third_party','comprehensive','fleet']),
      monthlyPremium:z.number().int().min(10),deductible:z.number().int().min(0),
      maxPayout:z.number().int().min(100)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Produit invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3 AND company_type='insurance'`,
      [parsed.data.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Vous devez posséder une assurance"});
    const p=(await query(`
      INSERT INTO insurance_products(world_id,insurer_company_id,name,coverage_type,monthly_premium,deductible,max_payout)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `,[req.params.worldId,co.id,parsed.data.name,parsed.data.coverageType,parsed.data.monthlyPremium,parsed.data.deductible,parsed.data.maxPayout])).rows[0];
    res.status(201).json({product:p});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/insurance/products/:productId/subscribe",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({vehicleId:z.number().int().positive().nullable()}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Souscription invalide"});
    const prod=(await query(`SELECT * FROM insurance_products WHERE id=$1 AND world_id=$2 AND active=TRUE`,
      [req.params.productId,req.params.worldId])).rows[0];
    if(!prod)return res.status(404).json({error:"Produit introuvable"});
    if(parsed.data.vehicleId){
      const v=(await query(`SELECT id FROM vehicles WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
        [parsed.data.vehicleId,req.user.id,req.params.worldId])).rows[0];
      if(!v)return res.status(403).json({error:"Véhicule non autorisé"});
    }
    const pol=await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<Number(prod.monthly_premium))throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[prod.monthly_premium,req.user.id]);
      return (await c.query(`
        INSERT INTO insurance_policies(world_id,product_id,holder_user_id,vehicle_id)
        VALUES ($1,$2,$3,$4) RETURNING *
      `,[req.params.worldId,prod.id,req.user.id,parsed.data.vehicleId])).rows[0];
    });
    res.status(201).json({policy:pol});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.post("/api/world/:worldId/insurance/policies/:policyId/claims",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      incidentType:z.enum(['collision','theft','fire','vandalism','breakdown']),
      description:z.string().min(10).max(3000),
      requestedAmount:z.number().int().min(0).max(100000000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Sinistre invalide"});
    const pol=(await query(`SELECT * FROM insurance_policies WHERE id=$1 AND holder_user_id=$2 AND world_id=$3 AND status='active'`,
      [req.params.policyId,req.user.id,req.params.worldId])).rows[0];
    if(!pol)return res.status(404).json({error:"Contrat introuvable"});
    const cl=(await query(`
      INSERT INTO insurance_claims(world_id,policy_id,claimant_user_id,incident_type,description,requested_amount)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `,[req.params.worldId,pol.id,req.user.id,parsed.data.incidentType,parsed.data.description,parsed.data.requestedAmount])).rows[0];
    await broadcastNews(req.params.worldId,"insurance","Nouveau sinistre déclaré",{claimId:cl.id});
    res.status(201).json({claim:cl});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/insurance/claims/:claimId/approve",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({approvedAmount:z.number().int().min(0)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Montant invalide"});
    const claim=(await query(`
      SELECT ic.*,ip.max_payout,ip.deductible,c.owner_user_id AS insurer_owner
      FROM insurance_claims ic JOIN insurance_policies pol ON pol.id=ic.policy_id
      JOIN insurance_products ip ON ip.id=pol.product_id
      JOIN companies c ON c.id=ip.insurer_company_id
      WHERE ic.id=$1 AND ic.world_id=$2
    `,[req.params.claimId,req.params.worldId])).rows[0];
    if(!claim||claim.insurer_owner!==req.user.id)return res.status(403).json({error:"Non autorisé"});
    const payout=Math.max(0,Math.min(parsed.data.approvedAmount,Number(claim.max_payout))-Number(claim.deductible));
    await withTransaction(async c=>{
      const insurerW=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(insurerW.euros)<payout)throw Object.assign(new Error("Réserves insuffisantes"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[payout,req.user.id]);
      await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[payout,claim.claimant_user_id]);
      await c.query(`UPDATE insurance_claims SET approved_amount=$1,status='paid',reviewed_by_user_id=$2 WHERE id=$3`,
        [payout,req.user.id,claim.id]);
    });
    await broadcastNews(req.params.worldId,"insurance",`Sinistre #${claim.id} indemnisé`,{claimId:claim.id,payout});
    res.json({ok:true,payout});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== LOGISTIQUE =====
app.get("/api/world/:worldId/logistics",authRequired,async(req,res,next)=>{
  try{
    const jobs=(await query(`
      SELECT lj.*,c.name AS carrier_name FROM logistics_jobs lj
      LEFT JOIN companies c ON c.id=lj.carrier_company_id
      WHERE lj.world_id=$1 ORDER BY lj.created_at DESC LIMIT 100
    `,[req.params.worldId])).rows;
    res.json({jobs});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/logistics",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      cargoType:z.enum(['vehicle','parts','mixed']),
      originCity:z.string().min(1).max(80),destinationCity:z.string().min(1).max(80),
      vehicleId:z.number().int().positive().nullable().optional(),
      partId:z.number().int().positive().nullable().optional(),
      quantity:z.number().int().min(1).max(10000),
      offeredPrice:z.number().int().min(100)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Mission invalide"});
    const j=(await query(`
      INSERT INTO logistics_jobs(world_id,requester_user_id,cargo_type,origin_city,destination_city,vehicle_id,part_id,quantity,offered_price)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `,[req.params.worldId,req.user.id,parsed.data.cargoType,parsed.data.originCity,parsed.data.destinationCity,
      parsed.data.vehicleId||null,parsed.data.partId||null,parsed.data.quantity,parsed.data.offeredPrice])).rows[0];
    res.status(201).json({job:j});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/logistics/:jobId/accept",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const carrier=(await query(`SELECT * FROM companies WHERE owner_user_id=$1 AND world_id=$2 AND company_type='transport' LIMIT 1`,
      [req.user.id,req.params.worldId])).rows[0];
    if(!carrier)return res.status(403).json({error:"Vous devez posséder une entreprise de transport"});
    const j=(await query(`UPDATE logistics_jobs SET carrier_company_id=$1,status='accepted' WHERE id=$2 AND world_id=$3 AND status='open' RETURNING *`,
      [carrier.id,req.params.jobId,req.params.worldId])).rows[0];
    if(!j)return res.status(409).json({error:"Mission indisponible"});
    res.json({job:j});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/logistics/:jobId/deliver",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const j=(await query(`
      SELECT lj.*,c.owner_user_id AS carrier_owner FROM logistics_jobs lj
      JOIN companies c ON c.id=lj.carrier_company_id
      WHERE lj.id=$1 AND lj.world_id=$2
    `,[req.params.jobId,req.params.worldId])).rows[0];
    if(!j||j.carrier_owner!==req.user.id||!['accepted','in_transit'].includes(j.status))
      return res.status(403).json({error:"Mission non autorisée"});
    await withTransaction(async c=>{
      const rw=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[j.requester_user_id])).rows[0];
      if(Number(rw.euros)<Number(j.offered_price))throw Object.assign(new Error("Client insolvable"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[j.offered_price,j.requester_user_id]);
      await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[j.offered_price,req.user.id]);
      await c.query(`UPDATE logistics_jobs SET status='delivered',delivered_at=NOW() WHERE id=$1`,[j.id]);
    });
    await broadcastNews(req.params.worldId,"logistics","Livraison terminée",{jobId:j.id});
    res.json({ok:true});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== CAPITAL / PARTS D'ENTREPRISE =====
app.post("/api/world/:worldId/companies/:companyId/ipo",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({sharePrice:z.number().int().min(1).max(1000000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Prix invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [req.params.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Entreprise non autorisée"});
    await withTransaction(async c=>{
      await c.query(`UPDATE companies SET public_company=TRUE,share_price=$1 WHERE id=$2`,[parsed.data.sharePrice,co.id]);
      await c.query(`INSERT INTO company_shareholdings(company_id,user_id,shares)
        VALUES ($1,$2,$3) ON CONFLICT(company_id,user_id) DO UPDATE SET shares=EXCLUDED.shares`,
        [co.id,req.user.id,co.total_shares]);
    });
    await broadcastNews(req.params.worldId,"markets",`${co.name} ouvre son capital`,{companyId:co.id});
    res.json({ok:true});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/exchange",authRequired,async(req,res,next)=>{
  try{
    const companies=(await query(`
      SELECT id,name,company_type,share_price,total_shares,reputation
      FROM companies WHERE world_id=$1 AND public_company=TRUE ORDER BY reputation DESC,name
    `,[req.params.worldId])).rows;
    res.json({companies});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/exchange/:companyId/buy",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({shares:z.number().int().min(1).max(1000000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Ordre invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND world_id=$2 AND public_company=TRUE`,
      [req.params.companyId,req.params.worldId])).rows[0];
    if(!co)return res.status(404).json({error:"Société non cotée"});
    const ownerHolding=(await query(`SELECT shares FROM company_shareholdings WHERE company_id=$1 AND user_id=$2`,
      [co.id,co.owner_user_id])).rows[0];
    if(!ownerHolding||Number(ownerHolding.shares)<parsed.data.shares)return res.status(409).json({error:"Pas assez d'actions disponibles"});
    const total=Number(co.share_price)*parsed.data.shares;
    await withTransaction(async c=>{
      const bw=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(bw.euros)<total)throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[total,req.user.id]);
      await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[total,co.owner_user_id]);
      await c.query(`UPDATE company_shareholdings SET shares=shares-$1 WHERE company_id=$2 AND user_id=$3`,
        [parsed.data.shares,co.id,co.owner_user_id]);
      await c.query(`
        INSERT INTO company_shareholdings(company_id,user_id,shares) VALUES ($1,$2,$3)
        ON CONFLICT(company_id,user_id) DO UPDATE SET shares=company_shareholdings.shares+EXCLUDED.shares
      `,[co.id,req.user.id,parsed.data.shares]);
      await c.query(`INSERT INTO share_trades(world_id,company_id,buyer_user_id,seller_user_id,shares,price_per_share)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.worldId,co.id,req.user.id,co.owner_user_id,parsed.data.shares,co.share_price]);
    });
    broadcast(req.params.worldId,"share_trade",{companyId:co.id,shares:parsed.data.shares,price:co.share_price});
    res.json({ok:true,total});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== GOLD PRODUCTS + SIGNED PAYMENT WEBHOOK =====
app.get("/api/store/gold",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`SELECT code,label,gold_amount,price_cents FROM gold_products WHERE active=TRUE ORDER BY price_cents`);
    res.json({products:rows});
  }catch(e){next(e);}
});

app.post("/api/payments/webhook",express.raw({type:"application/json"}),async(req,res,next)=>{
  try{
    const raw=req.rawBody||Buffer.from(JSON.stringify(req.body||{}));
    const signature=req.headers["x-payment-signature"];
    if(!verifyPaymentSignature(raw,signature))return res.status(401).send("invalid signature");
    const event=JSON.parse(raw.toString("utf8"));
    const parsed=z.object({
      id:z.string().min(3).max(160),
      type:z.literal("payment.succeeded"),
      userId:z.number().int().positive(),
      productCode:z.string().min(3).max(50),
      amountCents:z.number().int().positive()
    }).safeParse(event);
    if(!parsed.success)return res.status(400).send("invalid event");
    const prod=(await query(`SELECT * FROM gold_products WHERE code=$1 AND active=TRUE`,[parsed.data.productCode])).rows[0];
    if(!prod||Number(prod.price_cents)!==parsed.data.amountCents)return res.status(400).send("product mismatch");
    const result=await withTransaction(async c=>{
      const exists=(await c.query(`SELECT id,status FROM payment_events WHERE provider_event_id=$1 FOR UPDATE`,
        [parsed.data.id])).rows[0];
      if(exists)return {duplicate:true};
      const ev=(await c.query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,user_id,amount_cents,gold_amount,raw_payload,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'received') RETURNING id
      `,[process.env.PAYMENT_PROVIDER||"test",parsed.data.id,parsed.data.type,parsed.data.userId,parsed.data.amountCents,prod.gold_amount,JSON.stringify(event)])).rows[0];
      const w=(await c.query(`SELECT gold FROM wallets WHERE user_id=$1 FOR UPDATE`,[parsed.data.userId])).rows[0];
      if(!w)throw new Error("wallet missing");
      const newGold=Number(w.gold)+Number(prod.gold_amount);
      await c.query(`UPDATE wallets SET gold=$1 WHERE user_id=$2`,[newGold,parsed.data.userId]);
      await c.query(`INSERT INTO ledger_entries(user_id,currency,amount,balance_after,reason,reference_type,reference_id)
        VALUES ($1,'GOLD',$2,$3,'GOLD_PURCHASE','payment_event',$4)`,
        [parsed.data.userId,prod.gold_amount,newGold,ev.id]);
      await c.query(`UPDATE payment_events SET status='processed',processed_at=NOW() WHERE id=$1`,[ev.id]);
      return {duplicate:false,gold:prod.gold_amount};
    });
    res.json({ok:true,...result});
  }catch(e){next(e);}
});



// ===== MATIERES PREMIERES =====
app.get("/api/economy/materials",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`SELECT * FROM raw_materials ORDER BY name`);
    res.json({materials:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/materials/buy",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      companyId:z.number().int().positive(),
      materialId:z.number().int().positive(),
      quantity:z.number().int().min(1).max(10000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Achat invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [parsed.data.companyId,req.user.id,req.params.worldId])).rows[0];
    const mat=(await query(`SELECT * FROM raw_materials WHERE id=$1`,[parsed.data.materialId])).rows[0];
    if(!co||!mat)return res.status(404).json({error:"Entreprise ou matière introuvable"});
    const cost=Number(mat.current_price)*parsed.data.quantity;
    await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<cost)throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[cost,req.user.id]);
      await c.query(`
        INSERT INTO company_material_inventory(company_id,material_id,quantity)
        VALUES ($1,$2,$3)
        ON CONFLICT(company_id,material_id)
        DO UPDATE SET quantity=company_material_inventory.quantity+EXCLUDED.quantity
      `,[co.id,mat.id,parsed.data.quantity]);
    });
    res.json({ok:true,cost});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== SALARIES =====
app.post("/api/world/:worldId/companies/:companyId/employees",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      name:z.string().min(2).max(100),
      role:z.string().min(2).max(60),
      salaryDaily:z.number().int().min(0).max(100000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Employé invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [req.params.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Entreprise non autorisée"});
    const emp=(await query(`
      INSERT INTO employees(world_id,company_id,employee_name,role,salary_daily)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `,[req.params.worldId,co.id,parsed.data.name,parsed.data.role,parsed.data.salaryDaily])).rows[0];
    res.status(201).json({employee:emp});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/companies/:companyId/payroll",authRequired,async(req,res,next)=>{
  try{
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [req.params.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Entreprise non autorisée"});
    const employees=(await query(`SELECT * FROM employees WHERE company_id=$1 ORDER BY active DESC,hired_at DESC`,[co.id])).rows;
    const daily=employees.filter(e=>e.active).reduce((s,e)=>s+Number(e.salary_daily),0);
    res.json({employees,dailyPayroll:daily});
  }catch(e){next(e);}
});

// ===== FISCALITE =====
app.get("/api/world/:worldId/taxes/me",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT ta.*,c.name AS company_name,pe.name AS entity_name
      FROM tax_assessments ta
      JOIN companies c ON c.id=ta.company_id
      LEFT JOIN public_entities pe ON pe.id=ta.public_entity_id
      WHERE ta.world_id=$1 AND c.owner_user_id=$2
      ORDER BY ta.created_at DESC LIMIT 100
    `,[req.params.worldId,req.user.id]);
    res.json({taxes:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/taxes/:taxId/pay",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const tax=(await query(`
      SELECT ta.*,c.owner_user_id FROM tax_assessments ta
      JOIN companies c ON c.id=ta.company_id
      WHERE ta.id=$1 AND ta.world_id=$2
    `,[req.params.taxId,req.params.worldId])).rows[0];
    if(!tax||tax.owner_user_id!==req.user.id)return res.status(403).json({error:"Taxe non autorisée"});
    if(!['due','overdue'].includes(tax.status))return res.status(409).json({error:"Taxe déjà réglée"});
    await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<Number(tax.amount))throw Object.assign(new Error("Fonds insuffisants"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[tax.amount,req.user.id]);
      if(tax.public_entity_id)
        await c.query(`UPDATE public_entities SET treasury=treasury+$1 WHERE id=$2`,[tax.amount,tax.public_entity_id]);
      await c.query(`UPDATE tax_assessments SET status='paid' WHERE id=$1`,[tax.id]);
      await c.query(`
        INSERT INTO company_financials(company_id,unpaid_taxes)
        VALUES ($1,0)
        ON CONFLICT(company_id) DO UPDATE SET unpaid_taxes=GREATEST(0,company_financials.unpaid_taxes-$2)
      `,[tax.company_id,tax.amount]);
    });
    res.json({ok:true});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== MARCHES PUBLICS / APPELS D'OFFRES =====
app.get("/api/world/:worldId/public-tenders",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT pt.*,pe.name AS entity_name,c.name AS winner_company
      FROM public_tenders pt
      JOIN public_entities pe ON pe.id=pt.entity_id
      LEFT JOIN companies c ON c.id=pt.winner_company_id
      WHERE pt.world_id=$1 ORDER BY pt.created_at DESC LIMIT 100
    `,[req.params.worldId]);
    res.json({tenders:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/public-tenders",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      entityId:z.number().int().positive(),
      title:z.string().min(4).max(160),
      tenderType:z.enum(['vehicles','repair','transport','insurance','parts','infrastructure']),
      budget:z.number().int().min(1000),
      closesAt:z.string().datetime()
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Marché invalide"});
    const office=await getOfficeForUser(req.user.id,req.params.worldId,parsed.data.entityId);
    if(!office)return res.status(403).json({error:"Vous ne dirigez pas ce territoire"});
    const ent=(await query(`SELECT * FROM public_entities WHERE id=$1 AND world_id=$2`,[parsed.data.entityId,req.params.worldId])).rows[0];
    if(!ent||Number(ent.treasury)<parsed.data.budget)return res.status(409).json({error:"Budget public insuffisant"});
    const t=(await query(`
      INSERT INTO public_tenders(world_id,entity_id,title,tender_type,budget,closes_at)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `,[req.params.worldId,ent.id,parsed.data.title,parsed.data.tenderType,parsed.data.budget,parsed.data.closesAt])).rows[0];
    await broadcastNews(req.params.worldId,"politics",`Nouveau marché public : ${t.title}`,{tenderId:t.id});
    res.status(201).json({tender:t});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/public-tenders/:tenderId/bid",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      companyId:z.number().int().positive(),
      amount:z.number().int().min(1),
      qualityScore:z.number().int().min(0).max(100),
      message:z.string().max(1000).default("")
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Offre invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [parsed.data.companyId,req.user.id,req.params.worldId])).rows[0];
    const tender=(await query(`SELECT * FROM public_tenders WHERE id=$1 AND world_id=$2`,[req.params.tenderId,req.params.worldId])).rows[0];
    if(!co||!tender||tender.status!=="open")return res.status(409).json({error:"Marché indisponible"});
    await query(`
      INSERT INTO public_tender_bids(tender_id,company_id,amount,quality_score,message)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(tender_id,company_id)
      DO UPDATE SET amount=EXCLUDED.amount,quality_score=EXCLUDED.quality_score,message=EXCLUDED.message,created_at=NOW()
    `,[tender.id,co.id,parsed.data.amount,parsed.data.qualityScore,parsed.data.message]);
    res.json({ok:true});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/public-tenders/:tenderId/award",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const tender=(await query(`SELECT * FROM public_tenders WHERE id=$1 AND world_id=$2`,[req.params.tenderId,req.params.worldId])).rows[0];
    if(!tender)return res.status(404).json({error:"Marché introuvable"});
    const office=await getOfficeForUser(req.user.id,req.params.worldId,tender.entity_id);
    if(!office)return res.status(403).json({error:"Vous ne dirigez pas ce territoire"});
    const best=(await query(`
      SELECT b.*,c.name,c.owner_user_id,
        (b.quality_score*1000000 - b.amount) AS score
      FROM public_tender_bids b JOIN companies c ON c.id=b.company_id
      WHERE b.tender_id=$1 AND b.amount <= $2
      ORDER BY score DESC LIMIT 1
    `,[tender.id,tender.budget])).rows[0];
    if(!best)return res.status(409).json({error:"Aucune offre admissible"});
    await withTransaction(async c=>{
      const ent=(await c.query(`SELECT treasury FROM public_entities WHERE id=$1 FOR UPDATE`,[tender.entity_id])).rows[0];
      if(Number(ent.treasury)<Number(best.amount))throw Object.assign(new Error("Trésorerie publique insuffisante"),{status:409});
      await c.query(`UPDATE public_entities SET treasury=treasury-$1 WHERE id=$2`,[best.amount,tender.entity_id]);
      await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[best.amount,best.owner_user_id]);
      await c.query(`UPDATE public_tenders SET status='awarded',winner_company_id=$1,awarded_amount=$2 WHERE id=$3`,
        [best.company_id,best.amount,tender.id]);
    });
    await broadcastNews(req.params.worldId,"politics",`Marché public attribué à ${best.name}`,{tenderId:tender.id,amount:best.amount});
    res.json({ok:true,winnerCompanyId:best.company_id,amount:Number(best.amount)});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== FAILLITES =====
app.get("/api/world/:worldId/bankruptcies",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT bc.*,c.name AS company_name,c.company_type
      FROM bankruptcy_cases bc JOIN companies c ON c.id=bc.company_id
      WHERE bc.world_id=$1 ORDER BY bc.opened_at DESC LIMIT 100
    `,[req.params.worldId]);
    res.json({bankruptcies:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/bankruptcies/:caseId/liquidate",authRequired,requireRoles(['admin','judge']),actionLimiter,async(req,res,next)=>{
  try{
    const bc=(await query(`
      SELECT bc.*,c.owner_user_id FROM bankruptcy_cases bc
      JOIN companies c ON c.id=bc.company_id
      WHERE bc.id=$1 AND bc.world_id=$2
    `,[req.params.caseId,req.params.worldId])).rows[0];
    if(!bc)return res.status(404).json({error:"Dossier introuvable"});
    await withTransaction(async c=>{
      await c.query(`UPDATE bankruptcy_cases SET status='liquidation' WHERE id=$1`,[bc.id]);
      await c.query(`UPDATE company_financials SET status='liquidation' WHERE company_id=$1`,[bc.company_id]);
      await c.query(`UPDATE companies SET reputation=0 WHERE id=$1`,[bc.company_id]);
      await c.query(`UPDATE vehicles SET status='seized' WHERE owner_user_id=$1 AND world_id=$2`,[bc.owner_user_id,req.params.worldId]);
    });
    await broadcastNews(req.params.worldId,"economy",`Liquidation ouverte pour une entreprise`,{bankruptcyCaseId:bc.id});
    res.json({ok:true});
  }catch(e){next(e);}
});

// ===== ECONOMIE TERRITORIALE =====
app.get("/api/world/:worldId/territory-economy",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT pe.id,pe.entity_type,pe.name,pe.treasury,pe.tax_business,
             tm.population,tm.employment_rate,tm.economic_index,
             tm.vehicle_demand_index,tm.logistics_index,tm.industry_index
      FROM public_entities pe
      LEFT JOIN territory_metrics tm ON tm.entity_id=pe.id
      WHERE pe.world_id=$1
      ORDER BY pe.entity_type,pe.name
    `,[req.params.worldId]);
    res.json({territories:rows});
  }catch(e){next(e);}
});

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({error:"Erreur serveur"});
});

const port=Number(process.env.PORT||3000);
const httpServer=http.createServer(app);
const wss=new WebSocketServer({server:httpServer,path:"/ws"});
let wsSeq=1;
wss.on("connection",(ws,req)=>{
  const id=wsSeq++;
  liveClients.set(id,ws);
  try{
    const url=new URL(req.url,"http://localhost");
    ws.worldId=url.searchParams.get("world")||null;
  }catch{}
  ws.send(JSON.stringify({type:"connected",worldId:ws.worldId,ts:new Date().toISOString()}));
  ws.on("close",()=>liveClients.delete(id));
});
httpServer.listen(port,()=>console.log(`Auto République API v1.1 sur http://localhost:${port}`));
