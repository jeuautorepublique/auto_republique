
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


async function addXp(userId,worldId,amount){
  const r=await query(`
    INSERT INTO player_progression(user_id,world_id,xp)
    VALUES ($1,$2,$3)
    ON CONFLICT(user_id,world_id)
    DO UPDATE SET xp=player_progression.xp+EXCLUDED.xp
    RETURNING *
  `,[userId,worldId,amount]);
  let p=r.rows[0];
  const calculatedLevel=Math.max(1,Math.floor(Math.sqrt(Number(p.xp)/250))+1);
  if(calculatedLevel>Number(p.level)){
    const gained=calculatedLevel-Number(p.level);
    const up=(await query(`UPDATE player_progression SET level=$1,skill_points=skill_points+$2 WHERE user_id=$3 AND world_id=$4 RETURNING *`,
      [calculatedLevel,gained,userId,worldId])).rows[0];
    p=up;
    await notify(userId,worldId,"Niveau supérieur",`Vous atteignez le niveau ${calculatedLevel}.`);
  }
  return p;
}

async function unlockAchievement(userId,worldId,code){
  const ach=(await query(`SELECT * FROM achievements WHERE code=$1`,[code])).rows[0];
  if(!ach)return null;
  const inserted=(await query(`
    INSERT INTO player_achievements(user_id,world_id,achievement_id)
    VALUES ($1,$2,$3)
    ON CONFLICT DO NOTHING RETURNING *
  `,[userId,worldId,ach.id])).rows[0];
  if(!inserted)return null;
  if(Number(ach.reward_gold)>0){
    await query(`UPDATE wallets SET gold=gold+$1 WHERE user_id=$2`,[ach.reward_gold,userId]);
  }
  await addXp(userId,worldId,Number(ach.reward_xp));
  await notify(userId,worldId,`Succès : ${ach.name}`,`${ach.description} • +${ach.reward_gold} Gold • +${ach.reward_xp} XP`);
  return ach;
}


function stripeKey(){
  const key=process.env.STRIPE_SECRET_KEY||"";
  if(!key.startsWith("sk_")) throw new Error("STRIPE_SECRET_KEY manquante ou invalide");
  return key;
}

async function stripeRequest(path,params){
  const body=new URLSearchParams();
  for(const [k,v] of Object.entries(params)){
    if(v===undefined || v===null) continue;
    body.append(k,String(v));
  }
  const r=await fetch(`https://api.stripe.com/v1${path}`,{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${stripeKey()}`,
      "Content-Type":"application/x-www-form-urlencoded"
    },
    body
  });
  const data=await r.json();
  if(!r.ok) throw Object.assign(new Error(data?.error?.message||"Erreur Stripe"),{status:502});
  return data;
}

function parseStripeSignature(header){
  const out={t:null,v1:[]};
  for(const part of String(header||"").split(",")){
    const [k,v]=part.split("=");
    if(k==="t") out.t=v;
    if(k==="v1") out.v1.push(v);
  }
  return out;
}

function verifyStripeWebhook(rawBody,signatureHeader){
  const secret=process.env.STRIPE_WEBHOOK_SECRET||"";
  if(!secret || !rawBody || !signatureHeader) return false;
  const sig=parseStripeSignature(signatureHeader);
  if(!sig.t || !sig.v1.length) return false;
  const age=Math.abs(Math.floor(Date.now()/1000)-Number(sig.t));
  if(!Number.isFinite(age) || age>300) return false;
  const payload=`${sig.t}.${rawBody.toString("utf8")}`;
  const expected=crypto.createHmac("sha256",secret).update(payload).digest("hex");
  return sig.v1.some(candidate=>{
    try{
      return crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(candidate,"hex"));
    }catch{return false;}
  });
}


async function isPremium(userId){
  const r=await query(`
    SELECT status,current_period_end FROM premium_subscriptions
    WHERE user_id=$1
  `,[userId]);
  const s=r.rows[0];
  if(!s) return false;
  if(!['active','trialing'].includes(s.status)) return false;
  if(s.current_period_end && new Date(s.current_period_end)<=new Date()) return false;
  return true;
}

function premiumRequired(){
  return async (req,res,next)=>{
    try{
      if(!(await isPremium(req.user.id)))
        return res.status(403).json({error:"Fonction réservée aux membres Premium"});
      next();
    }catch(e){next(e);}
  };
}

async function upsertPremiumSubscription(userId,data){
  await query(`
    INSERT INTO premium_subscriptions(
      user_id,provider,provider_customer_id,provider_subscription_id,status,
      current_period_start,current_period_end,cancel_at_period_end,updated_at
    )
    VALUES ($1,'stripe',$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT(user_id) DO UPDATE SET
      provider_customer_id=EXCLUDED.provider_customer_id,
      provider_subscription_id=EXCLUDED.provider_subscription_id,
      status=EXCLUDED.status,
      current_period_start=EXCLUDED.current_period_start,
      current_period_end=EXCLUDED.current_period_end,
      cancel_at_period_end=EXCLUDED.cancel_at_period_end,
      updated_at=NOW()
  `,[userId,data.customerId||null,data.subscriptionId||null,data.status||'inactive',
     data.periodStart||null,data.periodEnd||null,Boolean(data.cancelAtPeriodEnd)]);
}


async function economySnapshot(worldId){
  const euros=Number((await query(`SELECT COALESCE(SUM(euros),0)::bigint AS v FROM wallets`)).rows[0].v);
  const gold=Number((await query(`SELECT COALESCE(SUM(gold),0)::bigint AS v FROM wallets`)).rows[0].v);
  const users=Number((await query(`SELECT COUNT(*)::int AS v FROM users WHERE is_banned=FALSE`)).rows[0].v);
  const companies=Number((await query(`SELECT COUNT(*)::int AS v FROM companies WHERE world_id=$1`,[worldId])).rows[0].v);
  const vehicles=Number((await query(`SELECT COUNT(*)::int AS v FROM vehicles WHERE world_id=$1`,[worldId])).rows[0].v);
  const loans=Number((await query(`SELECT COUNT(*)::int AS v FROM loans WHERE world_id=$1 AND status='active'`,[worldId])).rows[0].v);
  const bankruptcies=Number((await query(`SELECT COUNT(*)::int AS v FROM bankruptcy_cases WHERE world_id=$1 AND status IN ('opened','restructuring','liquidation')`,[worldId])).rows[0].v);
  const listings=Number((await query(`SELECT COUNT(*)::int AS v FROM market_listings WHERE world_id=$1 AND status='active'`,[worldId])).rows[0].v);
  const premium=Number((await query(`SELECT COUNT(*)::int AS v FROM premium_subscriptions WHERE status IN ('active','trialing')`)).rows[0].v);
  return {worldId,totalEuros:euros,totalGold:gold,usersCount:users,activeCompanies:companies,
          vehiclesCount:vehicles,activeLoans:loans,bankruptciesOpen:bankruptcies,
          marketListings:listings,premiumActive:premium};
}

async function persistSnapshot(worldId){
  const s=await economySnapshot(worldId);
  await query(`
    INSERT INTO admin_economy_snapshots(
      world_id,total_euros,total_gold,users_count,active_companies,vehicles_count,
      active_loans,bankruptcies_open,market_listings,premium_active
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `,[worldId,s.totalEuros,s.totalGold,s.usersCount,s.activeCompanies,s.vehiclesCount,
     s.activeLoans,s.bankruptciesOpen,s.marketListings,s.premiumActive]);
  return s;
}


// ===== V2.2 REGLES D'INCOMPATIBILITE =====
async function userHasPoliticalFunction(userId,worldId){
  const offices=(await query(`
    SELECT 1 FROM offices
    WHERE holder_user_id=$1 AND world_id=$2
      AND (mandate_end IS NULL OR mandate_end>NOW())
    LIMIT 1
  `,[userId,worldId])).rows[0];
  if(offices) return true;

  const roles=(await query(`
    SELECT 1 FROM user_roles
    WHERE user_id=$1 AND (world_id=$2 OR world_id IS NULL)
      AND role IN ('mayor','regional_president','president')
    LIMIT 1
  `,[userId,worldId])).rows[0];
  return Boolean(roles);
}

async function userHasBankActivity(userId,worldId){
  const company=(await query(`
    SELECT 1 FROM companies
    WHERE owner_user_id=$1 AND world_id=$2 AND company_type='bank_private'
    LIMIT 1
  `,[userId,worldId])).rows[0];
  if(company) return true;

  const bank=(await query(`
    SELECT 1 FROM banks
    WHERE owner_user_id=$1 AND world_id=$2
    LIMIT 1
  `,[userId,worldId])).rows[0];
  if(bank) return true;

  const role=(await query(`
    SELECT 1 FROM user_roles
    WHERE user_id=$1 AND (world_id=$2 OR world_id IS NULL)
      AND role='banker'
    LIMIT 1
  `,[userId,worldId])).rows[0];
  return Boolean(role);
}

async function userHasInsuranceActivity(userId,worldId){
  const company=(await query(`
    SELECT 1 FROM companies
    WHERE owner_user_id=$1 AND world_id=$2 AND company_type='insurance'
    LIMIT 1
  `,[userId,worldId])).rows[0];
  return Boolean(company);
}

async function userIsEditorInChief(userId,worldId){
  const pressRole=(await query(`
    SELECT 1
    FROM press_roles pr
    JOIN media_outlets mo ON mo.id=pr.media_id
    WHERE pr.user_id=$1 AND mo.world_id=$2
      AND pr.role='editor_in_chief'
    LIMIT 1
  `,[userId,worldId])).rows[0];
  if(pressRole) return true;

  const globalRole=(await query(`
    SELECT 1 FROM user_roles
    WHERE user_id=$1 AND (world_id=$2 OR world_id IS NULL)
      AND role='editor_in_chief'
    LIMIT 1
  `,[userId,worldId])).rows[0];
  return Boolean(globalRole);
}

async function userOwnsGarage(userId,worldId){
  const r=(await query(`
    SELECT 1 FROM companies
    WHERE owner_user_id=$1 AND world_id=$2 AND company_type='garage'
    LIMIT 1
  `,[userId,worldId])).rows[0];
  return Boolean(r);
}

async function userOwnsInspectionCenter(userId,worldId){
  const r=(await query(`
    SELECT 1 FROM inspection_centers
    WHERE owner_user_id=$1 AND world_id=$2 AND active=TRUE
    LIMIT 1
  `,[userId,worldId])).rows[0];
  return Boolean(r);
}

async function assertCompatibleActivity(userId,worldId,target){
  if(target==='inspection_center' && await userOwnsGarage(userId,worldId))
    throw Object.assign(new Error("Incompatibilité : un propriétaire de garage automobile ne peut pas exploiter un centre de contrôle technique."),{status:409,code:"GARAGE_CT_CONFLICT"});

  if(target==='garage' && await userOwnsInspectionCenter(userId,worldId))
    throw Object.assign(new Error("Incompatibilité : un exploitant de contrôle technique ne peut pas créer ou posséder un garage automobile."),{status:409,code:"CT_GARAGE_CONFLICT"});

  if(target==='editor_in_chief' && await userHasPoliticalFunction(userId,worldId))
    throw Object.assign(new Error("Incompatibilité : un rédacteur en chef ne peut pas cumuler avec une fonction politique."),{status:409,code:"PRESS_POLITICS_CONFLICT"});

  if(target==='politics'){
    if(await userIsEditorInChief(userId,worldId))
      throw Object.assign(new Error("Incompatibilité : une fonction politique ne peut pas être cumulée avec le poste de rédacteur en chef."),{status:409,code:"POLITICS_PRESS_CONFLICT"});
    if(await userHasBankActivity(userId,worldId))
      throw Object.assign(new Error("Incompatibilité : une fonction politique ne peut pas être cumulée avec une activité bancaire."),{status:409,code:"POLITICS_BANK_CONFLICT"});
    if(await userHasInsuranceActivity(userId,worldId))
      throw Object.assign(new Error("Incompatibilité : une fonction politique ne peut pas être cumulée avec une activité d'assurance."),{status:409,code:"POLITICS_INSURANCE_CONFLICT"});
  }

  if(target==='bank' && await userHasPoliticalFunction(userId,worldId))
    throw Object.assign(new Error("Incompatibilité : une activité bancaire ne peut pas être cumulée avec une fonction politique."),{status:409,code:"BANK_POLITICS_CONFLICT"});

  if(target==='insurance' && await userHasPoliticalFunction(userId,worldId))
    throw Object.assign(new Error("Incompatibilité : une activité d'assurance ne peut pas être cumulée avec une fonction politique."),{status:409,code:"INSURANCE_POLITICS_CONFLICT"});
}


// ===== V2.3 MULTIJOUEUR =====
const realtimeTickets=new Map();
const realtimeUsers=new Map();

function makeRealtimeTicket(userId,worldId){
  const ticket=crypto.randomBytes(32).toString("hex");
  realtimeTickets.set(ticket,{userId:Number(userId),worldId,expiresAt:Date.now()+60000});
  return ticket;
}
function consumeRealtimeTicket(ticket){
  const data=realtimeTickets.get(ticket);
  realtimeTickets.delete(ticket);
  if(!data || data.expiresAt<Date.now()) return null;
  return data;
}
async function setPresence(userId,worldId,connected){
  await query(`
    INSERT INTO player_presence(user_id,world_id,connected,last_seen_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT(user_id,world_id)
    DO UPDATE SET connected=EXCLUDED.connected,last_seen_at=NOW()
  `,[userId,worldId,connected]);
}
async function emitMultiplayerEvent(worldId,eventType,actorUserId,payload={}){
  await query(`
    INSERT INTO multiplayer_events(world_id,event_type,actor_user_id,payload)
    VALUES ($1,$2,$3,$4::jsonb)
  `,[worldId,eventType,actorUserId||null,JSON.stringify(payload)]);
  broadcast(worldId,eventType,payload);
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

    for(const worldId of ['beta','world1']){
      await query(`INSERT INTO player_progression(user_id,world_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[user.id,worldId]);
      for(const step of ['welcome','buy_vehicle','create_company','visit_bank','read_press']){
        await query(`INSERT INTO tutorial_progress(user_id,world_id,step_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [user.id,worldId,step]);
      }
    }
    await query(`INSERT INTO player_profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING`,[user.id]);

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


// ===== V1.8 ACCES MODULES RESERVE PREMIUM =====
// Les routes de gestion sensibles de ces modules exigent un abonnement Premium actif.
// La vérification est faite côté serveur, donc masquer un bouton dans le navigateur ne suffit pas.
const premiumModulePrefixes=[
  "/api/politics",
  "/api/banks",
  "/api/insurance",
  "/api/bailiff"
];
app.use(async(req,res,next)=>{
  try{
    if(!req.path.startsWith("/api/")) return next();
    const gated=premiumModulePrefixes.some(prefix=>req.path.startsWith(prefix));
    if(!gated) return next();
    if(!req.user?.id)
      return res.status(401).json({error:"Authentification requise"});
    if(!(await isPremium(req.user.id)))
      return res.status(403).json({
        error:"Ce module nécessite Auto République Premium",
        premiumRequired:true,
        premiumPriceCents:5999,
        premiumInterval:"month"
      });
    next();
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
    await unlockAchievement(req.user.id,worldId,"ACH_FIRST_CAR");
    await addXp(req.user.id,worldId,75);
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

      // Contrôle technique obligatoire pour voiture/utilitaire de 4 ans ou plus.
      const currentYear=new Date().getFullYear();
      if(['car','van'].includes(vr.vehicle_type) && currentYear-Number(vr.year)>=4){
        const ct=(await c.query(`
          SELECT * FROM vehicle_inspections
          WHERE vehicle_id=$1 AND result='passed' AND valid_until>NOW()
          ORDER BY created_at DESC LIMIT 1
        `,[vr.id])).rows[0];
        if(!ct) throw Object.assign(new Error("Contrôle technique valide obligatoire avant la mise en vente"),{status:409});
      }
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
      type:z.enum(['garage','vehicle_inspection','dealership','rental','transport','parts','manufacturer','bank_private','insurance','press','law_firm','bailiff_office']),
      city:z.string().min(1).max(80),
      region:z.string().min(1).max(120)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Données invalides"});
    if(parsed.data.type==='garage') await assertCompatibleActivity(req.user.id,req.params.worldId,'garage');
    if(parsed.data.type==='bank_private') await assertCompatibleActivity(req.user.id,req.params.worldId,'bank');
    if(parsed.data.type==='insurance') await assertCompatibleActivity(req.user.id,req.params.worldId,'insurance');
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
    await unlockAchievement(req.user.id,req.params.worldId,"ACH_FIRST_COMPANY");
    await addXp(req.user.id,req.params.worldId,150);
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
    await assertCompatibleActivity(req.user.id,req.params.worldId,'politics');
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
    // winner became incompatible since candidacy? refuse the office.
    await assertCompatibleActivity(Number(result.candidate_user_id),req.params.worldId,'politics');
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

      
      // Primes mensuelles simplifiées des assurances personnalisées arrivées à échéance
      const insuranceDue=(await c.query(`
        SELECT * FROM insurance_custom_contracts
        WHERE world_id=$1 AND status='active' AND next_payment_at<=NOW()
        FOR UPDATE
      `,[worldId])).rows;
      for(const ins of insuranceDue){
        const hw=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[ins.holder_user_id])).rows[0];
        if(hw && Number(hw.euros)>=Number(ins.monthly_premium)){
          await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[ins.monthly_premium,ins.holder_user_id]);
          await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[ins.monthly_premium,ins.insurer_user_id]);
          await c.query(`UPDATE insurance_custom_contracts SET next_payment_at=next_payment_at+INTERVAL '1 month' WHERE id=$1`,[ins.id]);
        }else{
          await c.query(`UPDATE insurance_custom_contracts SET status='suspended' WHERE id=$1`,[ins.id]);
        }
      }

      // Liquidité PNJ : achat limité des annonces sous le prix plafond
      const npcDemands=(await c.query(`
        SELECT nd.*,pe.name AS city FROM npc_market_demand nd
        JOIN public_entities pe ON pe.id=nd.entity_id
        WHERE nd.world_id=$1 AND nd.active=TRUE
      `,[worldId])).rows;
      for(const nd of npcDemands){
        const candidates=(await c.query(`
          SELECT ml.*,v.vehicle_type
          FROM market_listings ml JOIN vehicles v ON v.id=ml.vehicle_id
          WHERE ml.world_id=$1 AND ml.status='active' AND v.vehicle_type=$2
            AND ml.price<=$3 AND ml.seller_user_id IS NOT NULL
          ORDER BY ml.price ASC LIMIT $4
          FOR UPDATE SKIP LOCKED
        `,[worldId,nd.vehicle_type,nd.max_price,Math.min(Number(nd.daily_demand),3)])).rows;
        for(const listing of candidates){
          const seller=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[listing.seller_user_id])).rows[0];
          if(seller){
            await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[listing.price,listing.seller_user_id]);
            await c.query(`UPDATE market_listings SET status='sold',sold_at=NOW() WHERE id=$1`,[listing.id]);
            await c.query(`UPDATE vehicles SET owner_user_id=NULL,status='garage' WHERE id=$1`,[listing.vehicle_id]);
          }
        }
      }

      // Création occasionnelle d'événements mondiaux
      if(Math.random()<0.08){
        const pool=[
          ['auto_show','Salon automobile','Un salon automobile stimule temporairement la demande.'],
          ['battery_shortage','Tension sur les batteries','Les batteries électriques deviennent plus rares.'],
          ['tourism_boom','Boom touristique','La location de véhicules profite d’une forte demande.'],
          ['supply_shortage','Pénurie industrielle','Certaines chaînes d’approvisionnement ralentissent.']
        ];
        const pick=pool[Math.floor(Math.random()*pool.length)];
        await c.query(`
          INSERT INTO world_events(world_id,event_type,title,description,effect_json,starts_at,ends_at)
          VALUES ($1,$2,$3,$4,'{}'::jsonb,NOW(),NOW()+INTERVAL '3 days')
        `,[worldId,pick[0],pick[1],pick[2]]);
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
    if(['mayor','regional_president','president'].includes(parsed.data.role))
      await assertCompatibleActivity(Number(u.id),req.params.worldId,'politics');
    if(parsed.data.role==='banker')
      await assertCompatibleActivity(Number(u.id),req.params.worldId,'bank');
    if(parsed.data.role==='editor_in_chief')
      await assertCompatibleActivity(Number(u.id),req.params.worldId,'editor_in_chief');
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
      await persistSnapshot(worldId);
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



// ===== TUTORIEL / PROGRESSION =====
app.get("/api/world/:worldId/progression",authRequired,async(req,res,next)=>{
  try{
    await query(`INSERT INTO player_progression(user_id,world_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.user.id,req.params.worldId]);
    const progression=(await query(`SELECT * FROM player_progression WHERE user_id=$1 AND world_id=$2`,
      [req.user.id,req.params.worldId])).rows[0];
    const tutorial=(await query(`SELECT * FROM tutorial_progress WHERE user_id=$1 AND world_id=$2 ORDER BY step_code`,
      [req.user.id,req.params.worldId])).rows;
    const achievements=(await query(`
      SELECT a.code,a.name,a.description,a.reward_gold,a.reward_xp,pa.unlocked_at
      FROM achievements a
      LEFT JOIN player_achievements pa ON pa.achievement_id=a.id AND pa.user_id=$1 AND pa.world_id=$2
      ORDER BY a.id
    `,[req.user.id,req.params.worldId])).rows;
    res.json({progression,tutorial,achievements});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/tutorial/:stepCode/complete",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    await query(`
      INSERT INTO tutorial_progress(user_id,world_id,step_code,completed,completed_at)
      VALUES ($1,$2,$3,TRUE,NOW())
      ON CONFLICT(user_id,world_id,step_code)
      DO UPDATE SET completed=TRUE,completed_at=NOW()
    `,[req.user.id,req.params.worldId,req.params.stepCode]);
    const prog=await addXp(req.user.id,req.params.worldId,50);
    res.json({ok:true,progression:prog});
  }catch(e){next(e);}
});

// ===== PROFIL / PERSONNALISATION =====
app.get("/api/profile/:username",authRequired,async(req,res,next)=>{
  try{
    const u=(await query(`
      SELECT u.id,u.username,u.created_at,pp.bio,pp.avatar_url,pp.banner_url,pp.display_title
      FROM users u LEFT JOIN player_profiles pp ON pp.user_id=u.id
      WHERE LOWER(u.username)=LOWER($1)
    `,[req.params.username])).rows[0];
    if(!u)return res.status(404).json({error:"Joueur introuvable"});
    res.json({profile:u});
  }catch(e){next(e);}
});

app.patch("/api/profile",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      bio:z.string().max(1000).optional(),
      displayTitle:z.string().max(80).optional()
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Profil invalide"});
    await query(`
      INSERT INTO player_profiles(user_id,bio,display_title)
      VALUES ($1,$2,$3)
      ON CONFLICT(user_id) DO UPDATE SET
      bio=COALESCE(EXCLUDED.bio,player_profiles.bio),
      display_title=COALESCE(EXCLUDED.display_title,player_profiles.display_title)
    `,[req.user.id,parsed.data.bio||'',parsed.data.displayTitle||'Entrepreneur']);
    res.json({ok:true});
  }catch(e){next(e);}
});

app.patch("/api/world/:worldId/companies/:companyId/branding",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      slogan:z.string().max(160).optional(),
      brandColor:z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Personnalisation invalide"});
    const co=(await query(`SELECT id FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [req.params.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Entreprise non autorisée"});
    await query(`UPDATE companies SET slogan=COALESCE($1,slogan),brand_color=COALESCE($2,brand_color) WHERE id=$3`,
      [parsed.data.slogan||null, parsed.data.brandColor, co.id]);
    res.json({ok:true});
  }catch(e){next(e);}
});

// ===== SOCIAL =====
app.post("/api/social/friends/:username",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const u=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[req.params.username])).rows[0];
    if(!u||u.id===req.user.id)return res.status(400).json({error:"Joueur invalide"});
    await query(`
      INSERT INTO friendships(requester_user_id,addressee_user_id,status)
      VALUES ($1,$2,'pending')
      ON CONFLICT(requester_user_id,addressee_user_id) DO NOTHING
    `,[req.user.id,u.id]);
    await notify(u.id,null,"Demande d'ami",`${req.user.username} souhaite vous ajouter.`);
    res.json({ok:true});
  }catch(e){next(e);}
});

app.post("/api/social/messages/:username",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({worldId:z.enum(['beta','world1']).nullable().optional(),body:z.string().min(1).max(2000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Message invalide"});
    const u=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[req.params.username])).rows[0];
    if(!u)return res.status(404).json({error:"Joueur introuvable"});
    const m=(await query(`INSERT INTO private_messages(world_id,sender_user_id,recipient_user_id,body)
      VALUES ($1,$2,$3,$4) RETURNING *`,
      [parsed.data.worldId||null,req.user.id,u.id,parsed.data.body])).rows[0];
    await notify(u.id,parsed.data.worldId||null,"Nouveau message",`${req.user.username} vous a envoyé un message.`);
    res.status(201).json({message:m});
  }catch(e){next(e);}
});

app.get("/api/social/inbox",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT pm.*,u.username AS sender FROM private_messages pm
      JOIN users u ON u.id=pm.sender_user_id
      WHERE pm.recipient_user_id=$1 ORDER BY pm.created_at DESC LIMIT 100
    `,[req.user.id]);
    res.json({messages:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/alliances",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({name:z.string().min(3).max(100),description:z.string().max(1500).default("")}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Alliance invalide"});
    const a=await withTransaction(async c=>{
      const ar=(await c.query(`INSERT INTO alliances(world_id,name,founder_user_id,description)
        VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.worldId,parsed.data.name,req.user.id,parsed.data.description])).rows[0];
      await c.query(`INSERT INTO alliance_members(alliance_id,user_id,role) VALUES ($1,$2,'founder')`,[ar.id,req.user.id]);
      return ar;
    });
    res.status(201).json({alliance:a});
  }catch(e){next(e);}
});

// ===== ASSURANCE PERSONNALISEE =====
app.get("/api/world/:worldId/insurance/custom/offers",authRequired,async(req,res,next)=>{
  try{
    const received=(await query(`
      SELECT ico.*,c.name AS insurer_name,u.username AS insurer_username,
             v.make,v.model
      FROM insurance_custom_offers ico
      JOIN companies c ON c.id=ico.insurer_company_id
      JOIN users u ON u.id=ico.insurer_user_id
      LEFT JOIN vehicles v ON v.id=ico.target_vehicle_id
      WHERE ico.world_id=$1 AND (ico.target_user_id=$2 OR ico.insurer_user_id=$2)
      ORDER BY ico.created_at DESC
    `,[req.params.worldId,req.user.id])).rows;
    res.json({offers:received});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/insurance/custom/offers",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      companyId:z.number().int().positive(),
      targetUsername:z.string().min(3).max(24),
      targetVehicleId:z.number().int().positive().nullable().optional(),
      name:z.string().min(3).max(120),
      monthlyPremium:z.number().int().min(1).max(10000000),
      deductible:z.number().int().min(0).max(100000000),
      maxPayout:z.number().int().min(100).max(1000000000),
      durationMonths:z.number().int().min(1).max(120),
      coverage:z.object({
        collision:z.boolean().default(false),
        theft:z.boolean().default(false),
        fire:z.boolean().default(false),
        vandalism:z.boolean().default(false),
        breakdown:z.boolean().default(false),
        glass:z.boolean().default(false),
        roadside:z.boolean().default(false),
        replacementVehicle:z.boolean().default(false)
      })
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Contrat invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3 AND company_type='insurance'`,
      [parsed.data.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Vous devez posséder une compagnie d'assurance"});
    const target=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[parsed.data.targetUsername])).rows[0];
    if(!target)return res.status(404).json({error:"Client introuvable"});
    if(parsed.data.targetVehicleId){
      const veh=(await query(`SELECT id FROM vehicles WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
        [parsed.data.targetVehicleId,target.id,req.params.worldId])).rows[0];
      if(!veh)return res.status(404).json({error:"Véhicule du client introuvable"});
    }
    const offer=(await query(`
      INSERT INTO insurance_custom_offers(
        world_id,insurer_company_id,insurer_user_id,target_user_id,target_vehicle_id,
        name,coverage,monthly_premium,deductible,max_payout,duration_months,status,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'offered',NOW()+INTERVAL '7 days')
      RETURNING *
    `,[req.params.worldId,co.id,req.user.id,target.id,parsed.data.targetVehicleId||null,
       parsed.data.name,JSON.stringify(parsed.data.coverage),parsed.data.monthlyPremium,
       parsed.data.deductible,parsed.data.maxPayout,parsed.data.durationMonths])).rows[0];
    await notify(target.id,req.params.worldId,"Nouvelle proposition d'assurance",
      `${co.name} vous propose "${offer.name}" à ${offer.monthly_premium} €/mois.`);
    res.status(201).json({offer});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/insurance/custom/offers/:offerId/accept",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const offer=(await query(`
      SELECT * FROM insurance_custom_offers
      WHERE id=$1 AND world_id=$2 AND target_user_id=$3 FOR UPDATE
    `,[req.params.offerId,req.params.worldId,req.user.id])).rows[0];
    if(!offer||offer.status!=="offered")return res.status(409).json({error:"Offre indisponible"});
    if(offer.expires_at && new Date(offer.expires_at)<new Date())return res.status(409).json({error:"Offre expirée"});
    const contract=await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<Number(offer.monthly_premium))
        throw Object.assign(new Error("Fonds insuffisants pour la première prime"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[offer.monthly_premium,req.user.id]);
      await c.query(`UPDATE wallets SET euros=euros+$1 WHERE user_id=$2`,[offer.monthly_premium,offer.insurer_user_id]);
      const cr=(await c.query(`
        INSERT INTO insurance_custom_contracts(
          world_id,offer_id,insurer_company_id,insurer_user_id,holder_user_id,vehicle_id,
          coverage,monthly_premium,deductible,max_payout,ends_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()+($11||' months')::interval)
        RETURNING *
      `,[req.params.worldId,offer.id,offer.insurer_company_id,offer.insurer_user_id,req.user.id,
         offer.target_vehicle_id,offer.coverage,offer.monthly_premium,offer.deductible,
         offer.max_payout,String(offer.duration_months)])).rows[0];
      await c.query(`UPDATE insurance_custom_offers SET status='accepted' WHERE id=$1`,[offer.id]);
      return cr;
    });
    await broadcastNews(req.params.worldId,"insurance","Un contrat d'assurance personnalisé vient d'être signé",{contractId:contract.id});
    res.status(201).json({contract});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.post("/api/world/:worldId/insurance/custom/offers/:offerId/reject",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const o=(await query(`UPDATE insurance_custom_offers SET status='rejected'
      WHERE id=$1 AND world_id=$2 AND target_user_id=$3 AND status='offered' RETURNING *`,
      [req.params.offerId,req.params.worldId,req.user.id])).rows[0];
    if(!o)return res.status(409).json({error:"Offre indisponible"});
    await notify(o.insurer_user_id,req.params.worldId,"Offre d'assurance refusée","Le client a refusé votre proposition.");
    res.json({ok:true});
  }catch(e){next(e);}
});

// ===== MARCHE NEGOCIABLE / FAVORIS =====
app.post("/api/world/:worldId/market/:listingId/offers",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({amount:z.number().int().min(1),message:z.string().max(500).default("")}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Offre invalide"});
    const listing=(await query(`SELECT * FROM market_listings WHERE id=$1 AND world_id=$2 AND status='active'`,
      [req.params.listingId,req.params.worldId])).rows[0];
    if(!listing||!['negotiable','fixed'].includes(listing.listing_type))return res.status(409).json({error:"Annonce non négociable"});
    if(listing.seller_user_id===req.user.id)return res.status(400).json({error:"Offre impossible"});
    const o=(await query(`INSERT INTO market_offers(listing_id,buyer_user_id,amount,message) VALUES ($1,$2,$3,$4) RETURNING *`,
      [listing.id,req.user.id,parsed.data.amount,parsed.data.message])).rows[0];
    if(listing.seller_user_id)await notify(listing.seller_user_id,req.params.worldId,"Offre reçue",
      `Nouvelle offre de ${parsed.data.amount} € sur votre véhicule.`);
    res.status(201).json({offer:o});
  }catch(e){next(e);}
});

app.post("/api/market/:listingId/watch",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    await query(`INSERT INTO market_watchlist(user_id,listing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.user.id,req.params.listingId]);
    res.json({ok:true});
  }catch(e){next(e);}
});

// ===== EVENEMENTS / SAISONS / CLASSEMENTS =====
app.get("/api/world/:worldId/events",authRequired,async(req,res,next)=>{
  try{
    const events=(await query(`
      SELECT * FROM world_events
      WHERE world_id=$1 AND active=TRUE AND starts_at<=NOW() AND ends_at>=NOW()
      ORDER BY starts_at DESC
    `,[req.params.worldId])).rows;
    res.json({events});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/leaderboard/:category",authRequired,async(req,res,next)=>{
  try{
    const cat=req.params.category;
    let rows=[];
    if(cat==="wealth"){
      rows=(await query(`
        SELECT u.username,w.euros AS score
        FROM wallets w JOIN users u ON u.id=w.user_id
        ORDER BY w.euros DESC LIMIT 100
      `)).rows;
    }else if(cat==="reputation"){
      rows=(await query(`
        SELECT u.username,wp.reputation AS score
        FROM world_profiles wp JOIN users u ON u.id=wp.user_id
        WHERE wp.world_id=$1 ORDER BY wp.reputation DESC LIMIT 100
      `,[req.params.worldId])).rows;
    }else{
      return res.status(400).json({error:"Classement inconnu"});
    }
    res.json({category:cat,ranking:rows.map((r,i)=>({...r,rank:i+1}))});
  }catch(e){next(e);}
});

// ===== MODERATION / SIGNALEMENT =====
app.post("/api/reports",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      reportedUsername:z.string().min(3).max(24).nullable().optional(),
      contentType:z.string().max(30).nullable().optional(),
      contentId:z.number().int().positive().nullable().optional(),
      reason:z.string().min(3).max(80),
      details:z.string().max(2000).default("")
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Signalement invalide"});
    let reported=null;
    if(parsed.data.reportedUsername){
      reported=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[parsed.data.reportedUsername])).rows[0];
    }
    const r=(await query(`
      INSERT INTO reports(reporter_user_id,reported_user_id,content_type,content_id,reason,details)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `,[req.user.id,reported?.id||null,parsed.data.contentType||null,parsed.data.contentId||null,
       parsed.data.reason,parsed.data.details])).rows[0];
    res.status(201).json({report:r});
  }catch(e){next(e);}
});



// ===== BOUTIQUE GOLD REELLE / STRIPE CHECKOUT =====
app.get("/api/store/gold/products",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT id,code,label,gold_amount,price_cents
      FROM gold_products
      WHERE active=TRUE
      ORDER BY price_cents
    `);
    res.json({products:rows,currency:(process.env.STRIPE_CURRENCY||"eur").toLowerCase()});
  }catch(e){next(e);}
});

app.get("/api/store/gold/history",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT cs.id,cs.amount_cents,cs.currency,cs.status,cs.created_at,cs.paid_at,
             gp.label,gp.gold_amount
      FROM checkout_sessions cs
      JOIN gold_products gp ON gp.id=cs.gold_product_id
      WHERE cs.user_id=$1
      ORDER BY cs.created_at DESC LIMIT 50
    `,[req.user.id]);
    res.json({purchases:rows});
  }catch(e){next(e);}
});

app.post("/api/store/gold/checkout",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({productCode:z.string().min(3).max(50)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Produit invalide"});

    const product=(await query(`
      SELECT id,code,label,gold_amount,price_cents
      FROM gold_products WHERE code=$1 AND active=TRUE
    `,[parsed.data.productCode])).rows[0];
    if(!product)return res.status(404).json({error:"Pack Gold introuvable"});

    const base=(process.env.PUBLIC_APP_URL||"").replace(/\/$/,"");
    if(!base) return res.status(500).json({error:"PUBLIC_APP_URL non configurée"});

    const currency=(process.env.STRIPE_CURRENCY||"eur").toLowerCase();

    const session=await stripeRequest("/checkout/sessions",{
      mode:"payment",
      success_url:`${base}/game.html?gold_payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:`${base}/game.html?gold_payment=cancelled`,
      client_reference_id:String(req.user.id),
      "metadata[user_id]":String(req.user.id),
      "metadata[product_code]":product.code,
      "line_items[0][quantity]":"1",
      "line_items[0][price_data][currency]":currency,
      "line_items[0][price_data][unit_amount]":String(product.price_cents),
      "line_items[0][price_data][product_data][name]":product.label,
      "line_items[0][price_data][product_data][description]":
        `${product.gold_amount} Gold Auto République`
    });

    await query(`
      INSERT INTO checkout_sessions(
        user_id,gold_product_id,provider,provider_session_id,amount_cents,currency,status,checkout_url
      ) VALUES ($1,$2,'stripe',$3,$4,$5,'created',$6)
      ON CONFLICT(provider_session_id) DO NOTHING
    `,[req.user.id,product.id,session.id,product.price_cents,currency,session.url]);

    await logAudit(req.user.id,"gold_checkout_created",
      {sessionId:session.id,productCode:product.code,amountCents:product.price_cents},req.ip);

    res.status(201).json({
      checkoutUrl:session.url,
      sessionId:session.id,
      product:{code:product.code,label:product.label,goldAmount:Number(product.gold_amount),priceCents:product.price_cents}
    });
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// Stripe envoie le webhook après le paiement.
// Les Gold ne sont JAMAIS crédités par le navigateur.
app.post("/api/payments/stripe/webhook",async(req,res,next)=>{
  try{
    const raw=req.rawBody;
    const sig=req.headers["stripe-signature"];
    if(!verifyStripeWebhook(raw,sig))
      return res.status(400).send("Invalid Stripe signature");

    const event=JSON.parse(raw.toString("utf8"));

    // Anti-rejeu / idempotence au niveau de l'événement
    const seen=(await query(`SELECT id,status FROM payment_events WHERE provider_event_id=$1`,[event.id])).rows[0];
    if(seen) return res.json({received:true,duplicate:true});

    
    // Cycle de vie des abonnements Premium
    if(event.type==="customer.subscription.updated" || event.type==="customer.subscription.deleted"){
      const sub=event.data?.object||{};
      const userId=Number(sub.metadata?.user_id||0);
      if(userId>0){
        await upsertPremiumSubscription(userId,{
          customerId:sub.customer,
          subscriptionId:sub.id,
          status:event.type==="customer.subscription.deleted"?"cancelled":sub.status,
          periodStart:sub.current_period_start?new Date(sub.current_period_start*1000).toISOString():null,
          periodEnd:sub.current_period_end?new Date(sub.current_period_end*1000).toISOString():null,
          cancelAtPeriodEnd:Boolean(sub.cancel_at_period_end)
        });
        await query(`
          INSERT INTO payment_events(provider,provider_event_id,event_type,user_id,amount_cents,gold_amount,raw_payload,status,currency)
          VALUES ('stripe',$1,$2,$3,0,0,$4::jsonb,'processed',$5)
        `,[event.id,event.type,userId,JSON.stringify(event),process.env.PREMIUM_CURRENCY||"eur"]);
        return res.json({received:true,premiumUpdated:true});
      }
    }

    if(event.type==="invoice.paid"){
      const invoice=event.data?.object||{};
      const subId=typeof invoice.subscription==="string"?invoice.subscription:invoice.subscription?.id;
      if(subId){
        const local=(await query(`SELECT * FROM premium_subscriptions WHERE provider_subscription_id=$1`,[subId])).rows[0];
        if(local){
          const firstReward=(await query(`SELECT COUNT(*)::int AS n FROM premium_rewards WHERE user_id=$1 AND reward_type='activation_gold'`,[local.user_id])).rows[0];
          const isFirst=Number(firstReward.n)===0;
          const reward=10000;
          await withTransaction(async c=>{
            const seen=(await c.query(`SELECT id FROM payment_events WHERE provider_event_id=$1 FOR UPDATE`,[event.id])).rows[0];
            if(seen)return;
            const w=(await c.query(`SELECT gold FROM wallets WHERE user_id=$1 FOR UPDATE`,[local.user_id])).rows[0];
            const newGold=Number(w.gold)+reward;
            await c.query(`UPDATE wallets SET gold=$1 WHERE user_id=$2`,[newGold,local.user_id]);
            await c.query(`INSERT INTO premium_rewards(user_id,reward_type,amount,reference_period)
              VALUES ($1,$2,$3,$4)`,
              [local.user_id,isFirst?'activation_gold':'renewal_gold',reward,String(invoice.period_end||'')]);
            await c.query(`INSERT INTO ledger_entries(user_id,currency,amount,balance_after,reason,reference_type)
              VALUES ($1,'GOLD',$2,$3,$4,'premium_subscription')`,
              [local.user_id,reward,newGold,isFirst?'PREMIUM_ACTIVATION_BONUS':'PREMIUM_RENEWAL_BONUS']);
            await c.query(`INSERT INTO payment_events(provider,provider_event_id,event_type,user_id,amount_cents,gold_amount,raw_payload,status,currency,processed_at)
              VALUES ('stripe',$1,$2,$3,$4,$5,$6::jsonb,'processed',$7,NOW())`,
              [event.id,event.type,local.user_id,Number(invoice.amount_paid||0),reward,JSON.stringify(event),String(invoice.currency||'eur')]);
          });
          await notify(local.user_id,null,"Avantage Premium",`${reward} Gold Premium viennent d'être ajoutés à votre compte.`);
          return res.json({received:true,premiumReward:reward});
        }
      }
    }

    if(event.type==="checkout.session.completed"){
      const checkout=event.data?.object||{};
      if(checkout.mode==="subscription" && checkout.metadata?.product==="premium_monthly"){
        const userId=Number(checkout.metadata?.user_id||checkout.client_reference_id);
        const subscriptionId=typeof checkout.subscription==="string"?checkout.subscription:checkout.subscription?.id;
        if(userId>0 && subscriptionId){
          const sub=await stripeRequest(`/subscriptions/${subscriptionId}`,{});
          await upsertPremiumSubscription(userId,{
            customerId:sub.customer,
            subscriptionId:sub.id,
            status:sub.status,
            periodStart:sub.current_period_start?new Date(sub.current_period_start*1000).toISOString():null,
            periodEnd:sub.current_period_end?new Date(sub.current_period_end*1000).toISOString():null,
            cancelAtPeriodEnd:Boolean(sub.cancel_at_period_end)
          });
          const exists=(await query(`SELECT id FROM payment_events WHERE provider_event_id=$1`,[event.id])).rows[0];
          if(!exists){
            await query(`INSERT INTO payment_events(provider,provider_event_id,event_type,user_id,amount_cents,gold_amount,raw_payload,status,currency,checkout_session_id,processed_at)
              VALUES ('stripe',$1,$2,$3,$4,0,$5::jsonb,'processed',$6,$7,NOW())`,
              [event.id,event.type,userId,Number(checkout.amount_total||0),JSON.stringify(event),String(checkout.currency||'eur'),checkout.id]);
          }
          await notify(userId,null,"Premium activé","Votre abonnement Auto République Premium est actif.");
          return res.json({received:true,premiumActivated:true});
        }
      }
    }

    if(event.type!=="checkout.session.completed"){
      await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,raw_payload,status,currency)
        VALUES ('stripe',$1,$2,$3::jsonb,'ignored',$4)
      `,[event.id,event.type,JSON.stringify(event),process.env.STRIPE_CURRENCY||"eur"]);
      return res.json({received:true,ignored:true});
    }

    const session=event.data?.object||{};
    const userId=Number(session.metadata?.user_id||session.client_reference_id);
    const productCode=session.metadata?.product_code;
    const amountTotal=Number(session.amount_total||0);
    const currency=String(session.currency||"").toLowerCase();

    if(!Number.isInteger(userId)||userId<=0||!productCode)
      return res.status(400).send("Missing metadata");

    const product=(await query(`
      SELECT id,code,label,gold_amount,price_cents FROM gold_products
      WHERE code=$1 AND active=TRUE
    `,[productCode])).rows[0];
    if(!product)return res.status(400).send("Unknown product");

    if(amountTotal!==Number(product.price_cents))
      return res.status(400).send("Amount mismatch");

    if(currency!==(process.env.STRIPE_CURRENCY||"eur").toLowerCase())
      return res.status(400).send("Currency mismatch");

    const result=await withTransaction(async c=>{
      // Verrouille la session checkout correspondante
      const cs=(await c.query(`
        SELECT * FROM checkout_sessions
        WHERE provider_session_id=$1 AND user_id=$2
        FOR UPDATE
      `,[session.id,userId])).rows[0];
      if(!cs) throw Object.assign(new Error("Checkout inconnu"),{status:400});
      if(cs.status==="paid") return {duplicate:true,gold:0};

      // Re-vérifie que la session locale pointe vers le même produit/prix
      if(Number(cs.gold_product_id)!==Number(product.id) || Number(cs.amount_cents)!==amountTotal)
        throw Object.assign(new Error("Checkout mismatch"),{status:400});

      // Enregistre d'abord l'événement Stripe, unique.
      const ev=(await c.query(`
        INSERT INTO payment_events(
          provider,provider_event_id,event_type,user_id,amount_cents,gold_amount,
          raw_payload,status,checkout_session_id,payment_intent_id,currency
        )
        VALUES ('stripe',$1,$2,$3,$4,$5,$6::jsonb,'received',$7,$8,$9)
        RETURNING id
      `,[event.id,event.type,userId,amountTotal,product.gold_amount,JSON.stringify(event),
         session.id,session.payment_intent||null,currency])).rows[0];

      const wallet=(await c.query(`SELECT gold FROM wallets WHERE user_id=$1 FOR UPDATE`,[userId])).rows[0];
      if(!wallet) throw new Error("Portefeuille introuvable");

      const newGold=Number(wallet.gold)+Number(product.gold_amount);
      await c.query(`UPDATE wallets SET gold=$1 WHERE user_id=$2`,[newGold,userId]);

      await c.query(`
        INSERT INTO ledger_entries(
          user_id,currency,amount,balance_after,reason,reference_type,reference_id
        ) VALUES ($1,'GOLD',$2,$3,'GOLD_PURCHASE_STRIPE','payment_event',$4)
      `,[userId,product.gold_amount,newGold,ev.id]);

      await c.query(`
        UPDATE checkout_sessions
        SET status='paid',paid_at=NOW()
        WHERE provider_session_id=$1
      `,[session.id]);

      await c.query(`
        UPDATE payment_events
        SET status='processed',processed_at=NOW()
        WHERE id=$1
      `,[ev.id]);

      return {duplicate:false,gold:Number(product.gold_amount),balance:newGold};
    });

    if(!result.duplicate){
      await notify(userId,null,"Gold crédité",
        `${result.gold} Gold ont été ajoutés à votre compte après confirmation du paiement.`);
      broadcast(null,"gold_purchase",{userId,gold:result.gold});
      await logAudit(userId,"gold_payment_processed",
        {stripeEventId:event.id,sessionId:session.id,gold:result.gold},req.ip);
    }

    res.json({received:true,...result});
  }catch(e){
    if(e.status)return res.status(e.status).send(e.message);
    next(e);
  }
});



// ===== PREMIUM 59,99 € / AN =====
app.get("/api/premium/status",authRequired,async(req,res,next)=>{
  try{
    const s=(await query(`
      SELECT status,current_period_start,current_period_end,cancel_at_period_end,updated_at
      FROM premium_subscriptions WHERE user_id=$1
    `,[req.user.id])).rows[0]||null;
    res.json({
      premium:await isPremium(req.user.id),
      subscription:s,
      offer:{
        label:"Auto République Premium",
        priceCents:Number(process.env.PREMIUM_PRICE_CENTS||5999),
        currency:(process.env.PREMIUM_CURRENCY||"eur").toLowerCase(),
        interval:process.env.PREMIUM_INTERVAL||"month"
      },
      benefits:[
        "10 000 Gold offerts à l’activation",
        "10 000 Gold à chaque mois Premium payé",
        "Analyse avancée du marché automobile",
        "20 favoris marché au lieu de 5",
        "3 alertes de marché premium",
        "Historique véhicule détaillé et estimations avancées",
        "Personnalisation Premium du profil et des entreprises",
        "Badge Premium visible dans la communauté",
        "Priorité dans certaines files d’interface et outils de gestion",
        "Statistiques avancées entreprises, banques, territoires et investissements"
      ]
    });
  }catch(e){next(e);}
});

app.post("/api/premium/checkout",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const base=(process.env.PUBLIC_APP_URL||"").replace(/\/$/,"");
    if(!base)return res.status(500).json({error:"PUBLIC_APP_URL non configurée"});

    const existing=(await query(`SELECT * FROM premium_subscriptions WHERE user_id=$1`,[req.user.id])).rows[0];
    if(existing && ['active','trialing'].includes(existing.status))
      return res.status(409).json({error:"Vous êtes déjà Premium"});

    const priceId=process.env.STRIPE_PREMIUM_PRICE_ID||"";
    if(!priceId.startsWith("price_"))
      return res.status(500).json({error:"STRIPE_PREMIUM_PRICE_ID non configuré"});

    const params={
      mode:"subscription",
      success_url:`${base}/game.html?premium=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:`${base}/game.html?premium=cancelled`,
      client_reference_id:String(req.user.id),
      "metadata[user_id]":String(req.user.id),
      "metadata[product]":"premium_monthly",
      "subscription_data[metadata][user_id]":String(req.user.id),
      "subscription_data[metadata][product]":"premium_monthly",
      "line_items[0][quantity]":"1",
      "line_items[0][price]":priceId
    };
    if(existing?.provider_customer_id) params.customer=existing.provider_customer_id;

    const session=await stripeRequest("/checkout/sessions",params);
    await logAudit(req.user.id,"premium_checkout_created",
      {sessionId:session.id},req.ip);

    res.status(201).json({checkoutUrl:session.url,sessionId:session.id});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.post("/api/premium/cancel",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const s=(await query(`SELECT * FROM premium_subscriptions WHERE user_id=$1`,[req.user.id])).rows[0];
    if(!s?.provider_subscription_id)return res.status(404).json({error:"Aucun abonnement actif"});
    const sub=await stripeRequest(`/subscriptions/${s.provider_subscription_id}`,{
      cancel_at_period_end:"true"
    });
    await upsertPremiumSubscription(req.user.id,{
      customerId:sub.customer,
      subscriptionId:sub.id,
      status:sub.status==="canceled"?"cancelled":sub.status,
      periodStart:sub.current_period_start?new Date(sub.current_period_start*1000).toISOString():null,
      periodEnd:sub.current_period_end?new Date(sub.current_period_end*1000).toISOString():null,
      cancelAtPeriodEnd:Boolean(sub.cancel_at_period_end)
    });
    res.json({ok:true,cancelAtPeriodEnd:Boolean(sub.cancel_at_period_end)});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== EXEMPLES DE BENEFICES PREMIUM =====
app.get("/api/world/:worldId/premium/market-insights",authRequired,premiumRequired(),async(req,res,next)=>{
  try{
    const rows=(await query(`
      SELECT v.vehicle_type,
             COUNT(*)::int AS listings,
             ROUND(AVG(ml.price))::bigint AS avg_price,
             MIN(ml.price)::bigint AS min_price,
             MAX(ml.price)::bigint AS max_price,
             ROUND(AVG(v.condition),1) AS avg_condition
      FROM market_listings ml
      JOIN vehicles v ON v.id=ml.vehicle_id
      WHERE ml.world_id=$1 AND ml.status='active'
      GROUP BY v.vehicle_type
      ORDER BY listings DESC
    `,[req.params.worldId])).rows;
    res.json({insights:rows});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/premium/company-insights",authRequired,premiumRequired(),async(req,res,next)=>{
  try{
    const companies=(await query(`
      SELECT c.id,c.name,c.company_type,c.reputation,c.cash,
             COALESCE(cf.debt,0) AS debt,
             COALESCE(cf.unpaid_wages,0) AS unpaid_wages,
             COALESCE(cf.unpaid_taxes,0) AS unpaid_taxes,
             COALESCE(cf.status,'active') AS financial_status
      FROM companies c
      LEFT JOIN company_financials cf ON cf.company_id=c.id
      WHERE c.world_id=$1 AND c.owner_user_id=$2
      ORDER BY c.created_at DESC
    `,[req.params.worldId,req.user.id])).rows;
    res.json({companies});
  }catch(e){next(e);}
});



// ===== ADMIN DASHBOARD =====
app.get("/api/admin/world/:worldId/dashboard",adminKeyRequired,async(req,res,next)=>{
  try{
    const snapshot=await persistSnapshot(req.params.worldId);
    const territories=(await query(`
      SELECT pe.id,pe.entity_type,pe.name,pe.treasury,
             tm.population,tm.employment_rate,tm.economic_index,
             tm.vehicle_demand_index,tm.logistics_index,tm.industry_index
      FROM public_entities pe
      LEFT JOIN territory_metrics tm ON tm.entity_id=pe.id
      WHERE pe.world_id=$1 ORDER BY pe.entity_type,pe.name
    `,[req.params.worldId])).rows;
    const riskyUsers=(await query(`
      SELECT u.username,COALESCE(SUM(ae.risk_score),0)::int AS risk
      FROM users u LEFT JOIN anti_abuse_events ae ON ae.user_id=u.id
      GROUP BY u.id,u.username ORDER BY risk DESC LIMIT 20
    `)).rows;
    res.json({snapshot,territories,riskyUsers});
  }catch(e){next(e);}
});

app.get("/api/admin/world/:worldId/snapshots",adminKeyRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT * FROM admin_economy_snapshots
      WHERE world_id=$1 ORDER BY created_at DESC LIMIT 200
    `,[req.params.worldId]);
    res.json({snapshots:rows});
  }catch(e){next(e);}
});

// ===== SIMULATEUR ECONOMIQUE 30/90/365 =====
app.post("/api/admin/world/:worldId/simulate",adminKeyRequired,async(req,res,next)=>{
  try{
    const parsed=z.object({days:z.union([z.literal(30),z.literal(90),z.literal(365)])}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Simulation autorisée : 30, 90 ou 365 jours"});
    const worldId=req.params.worldId;
    const before=await economySnapshot(worldId);
    const run=(await query(`
      INSERT INTO simulation_runs(world_id,requested_days,before_json,status)
      VALUES ($1,$2,$3::jsonb,'running') RETURNING *
    `,[worldId,parsed.data.days,JSON.stringify(before)])).rows[0];

    // Simulation analytique non destructive : projette les flux sans modifier le monde réel.
    const companies=(await query(`SELECT COUNT(*)::int AS v FROM companies WHERE world_id=$1`,[worldId])).rows[0].v;
    const payroll=Number((await query(`
      SELECT COALESCE(SUM(ec.salary_daily),0)::bigint AS v
      FROM employment_contracts ec WHERE ec.world_id=$1 AND ec.status='active'
    `,[worldId])).rows[0].v || 0);
    const legacyPayroll=Number((await query(`
      SELECT COALESCE(SUM(e.salary_daily),0)::bigint AS v
      FROM employees e WHERE e.world_id=$1 AND e.active=TRUE
    `,[worldId])).rows[0].v || 0);
    const taxDue=Number((await query(`
      SELECT COALESCE(SUM(amount),0)::bigint AS v FROM tax_assessments
      WHERE world_id=$1 AND status IN ('due','overdue')
    `,[worldId])).rows[0].v || 0);
    const activeLoans=Number((await query(`
      SELECT COALESCE(SUM(balance),0)::bigint AS v FROM loans
      WHERE world_id=$1 AND status='active'
    `,[worldId])).rows[0].v || 0);

    const days=parsed.data.days;
    const projectedPayroll=(payroll+legacyPayroll)*days;
    const projectedTax=Math.round((taxDue/7)*days);
    const projectedLoanInterest=Math.round(activeLoans*0.05*(days/365));
    const projectedInflation=Math.min(25,Math.max(-10,(Number(companies)/50)*2+(days/365)*3));

    const after={
      ...before,
      projectedDays:days,
      projectedPayroll,
      projectedTax,
      projectedLoanInterest,
      projectedInflationPercent:Number(projectedInflation.toFixed(2)),
      warnings:[
        projectedPayroll>before.totalEuros*0.35?"Masse salariale très élevée par rapport à la monnaie disponible":null,
        before.totalGold>Math.max(1,before.usersCount)*50000?"Stock de Gold élevé par joueur":null,
        before.bankruptciesOpen>Math.max(3,before.activeCompanies*0.15)?"Taux de faillites élevé":null
      ].filter(Boolean)
    };

    await query(`
      UPDATE simulation_runs SET status='completed',after_json=$1::jsonb,completed_at=NOW()
      WHERE id=$2
    `,[JSON.stringify(after),run.id]);

    res.json({runId:run.id,before,projection:after});
  }catch(e){next(e);}
});

// ===== CARTE / INFRASTRUCTURES TERRITORIALES =====
app.get("/api/world/:worldId/map-data",authRequired,async(req,res,next)=>{
  try{
    const territories=(await query(`
      SELECT pe.id,pe.entity_type,pe.name,pe.parent_id,pe.treasury,
             tm.population,tm.employment_rate,tm.economic_index,
             tm.vehicle_demand_index,tm.logistics_index,tm.industry_index
      FROM public_entities pe
      LEFT JOIN territory_metrics tm ON tm.entity_id=pe.id
      WHERE pe.world_id=$1
      ORDER BY pe.entity_type,pe.name
    `,[req.params.worldId])).rows;
    const infrastructure=(await query(`
      SELECT ti.*,pe.name AS territory_name
      FROM territory_infrastructure ti
      JOIN public_entities pe ON pe.id=ti.entity_id
      WHERE ti.world_id=$1 ORDER BY pe.name,ti.infrastructure_type
    `,[req.params.worldId])).rows;
    res.json({territories,infrastructure});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/infrastructure",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      entityId:z.number().int().positive(),
      infrastructureType:z.enum(['road','highway','rail_terminal','port','warehouse','industrial_zone','charging_network','fuel_station','bus_depot','vehicle_inspection_center']),
      name:z.string().min(3).max(120),
      cost:z.number().int().min(1000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Infrastructure invalide"});
    const office=await getOfficeForUser(req.user.id,req.params.worldId,parsed.data.entityId);
    if(!office)return res.status(403).json({error:"Vous ne dirigez pas ce territoire"});
    const infra=await withTransaction(async c=>{
      const ent=(await c.query(`SELECT treasury FROM public_entities WHERE id=$1 FOR UPDATE`,[parsed.data.entityId])).rows[0];
      if(!ent||Number(ent.treasury)<parsed.data.cost)throw Object.assign(new Error("Budget insuffisant"),{status:409});
      await c.query(`UPDATE public_entities SET treasury=treasury-$1 WHERE id=$2`,[parsed.data.cost,parsed.data.entityId]);
      return (await c.query(`
        INSERT INTO territory_infrastructure(world_id,entity_id,infrastructure_type,name,level,capacity,condition)
        VALUES ($1,$2,$3,$4,1,100,100) RETURNING *
      `,[req.params.worldId,parsed.data.entityId,parsed.data.infrastructureType,parsed.data.name])).rows[0];
    });
    await broadcastNews(req.params.worldId,"politics",`Nouvelle infrastructure : ${infra.name}`,{infrastructureId:infra.id});
    res.status(201).json({infrastructure:infra});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

// ===== EMPLOIS / ORGANIGRAMMES =====
app.get("/api/world/:worldId/companies/:companyId/staff",authRequired,async(req,res,next)=>{
  try{
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND world_id=$2`,[req.params.companyId,req.params.worldId])).rows[0];
    if(!co)return res.status(404).json({error:"Entreprise introuvable"});
    const staff=(await query(`
      SELECT * FROM employment_contracts WHERE company_id=$1 ORDER BY status,started_at
    `,[co.id])).rows;
    res.json({company:co,staff});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/companies/:companyId/staff",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      employeeUsername:z.string().min(3).max(24).nullable().optional(),
      employeeName:z.string().min(2).max(100),
      role:z.string().min(2).max(60),
      salaryDaily:z.number().int().min(0).max(1000000),
      contractType:z.enum(['permanent','fixed_term','freelance']),
      permissions:z.record(z.boolean()).default({})
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Contrat invalide"});
    const co=(await query(`SELECT * FROM companies WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [req.params.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Entreprise non autorisée"});
    let employeeUserId=null;
    if(parsed.data.employeeUsername){
      const u=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[parsed.data.employeeUsername])).rows[0];
      employeeUserId=u?.id||null;
    }
    const c=(await query(`
      INSERT INTO employment_contracts(world_id,company_id,employee_user_id,employee_name,role,salary_daily,contract_type,permissions)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *
    `,[req.params.worldId,co.id,employeeUserId,parsed.data.employeeName,parsed.data.role,
       parsed.data.salaryDaily,parsed.data.contractType,JSON.stringify(parsed.data.permissions)])).rows[0];
    if(employeeUserId)await notify(employeeUserId,req.params.worldId,"Nouveau contrat de travail",`${co.name} vous propose un poste de ${c.role}.`);
    res.status(201).json({contract:c});
  }catch(e){next(e);}
});

// ===== VEHICULES PLUS PROFONDS =====
app.get("/api/world/:worldId/vehicles/:vehicleId/history-full",authRequired,async(req,res,next)=>{
  try{
    const vehicle=(await query(`SELECT * FROM vehicles WHERE id=$1 AND world_id=$2`,[req.params.vehicleId,req.params.worldId])).rows[0];
    if(!vehicle)return res.status(404).json({error:"Véhicule introuvable"});
    const [history,services,inspections,incidents]=await Promise.all([
      query(`SELECT * FROM vehicle_history WHERE vehicle_id=$1 ORDER BY created_at DESC`,[vehicle.id]),
      query(`SELECT * FROM vehicle_service_records WHERE vehicle_id=$1 ORDER BY created_at DESC`,[vehicle.id]),
      query(`SELECT * FROM vehicle_inspections WHERE vehicle_id=$1 ORDER BY created_at DESC`,[vehicle.id]),
      query(`SELECT * FROM vehicle_incidents WHERE vehicle_id=$1 ORDER BY created_at DESC`,[vehicle.id])
    ]);
    res.json({vehicle,history:history.rows,services:services.rows,inspections:inspections.rows,incidents:incidents.rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/vehicles/:vehicleId/incidents",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      incidentType:z.enum(['collision','breakdown','fire','theft','vandalism','weather']),
      severity:z.number().int().min(1).max(100),
      estimatedDamage:z.number().int().min(0),
      territoryId:z.number().int().positive().nullable().optional()
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Incident invalide"});
    const v=(await query(`SELECT * FROM vehicles WHERE id=$1 AND owner_user_id=$2 AND world_id=$3`,
      [req.params.vehicleId,req.user.id,req.params.worldId])).rows[0];
    if(!v)return res.status(403).json({error:"Véhicule non autorisé"});
    const incident=(await query(`
      INSERT INTO vehicle_incidents(world_id,vehicle_id,owner_user_id,incident_type,severity,estimated_damage,location_entity_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `,[req.params.worldId,v.id,req.user.id,parsed.data.incidentType,parsed.data.severity,parsed.data.estimatedDamage,parsed.data.territoryId||null])).rows[0];
    await query(`UPDATE vehicles SET accident_count=accident_count+1,condition=GREATEST(0,condition-$1) WHERE id=$2`,
      [Math.ceil(parsed.data.severity/5),v.id]);
    await broadcastNews(req.params.worldId,"automotive",`Incident sur ${v.make} ${v.model}`,{vehicleId:v.id,incidentId:incident.id});
    res.status(201).json({incident});
  }catch(e){next(e);}
});

// ===== POLITIQUE : CAMPAGNES / SONDAGES =====
app.post("/api/world/:worldId/elections/:electionId/campaign",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({budget:z.number().int().min(0).max(10000000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Campagne invalide"});
    const cand=(await query(`SELECT * FROM election_candidates WHERE election_id=$1 AND user_id=$2`,
      [req.params.electionId,req.user.id])).rows[0];
    if(!cand)return res.status(403).json({error:"Vous n'êtes pas candidat"});
    const campaign=(await query(`
      INSERT INTO political_campaigns(election_id,candidate_user_id,budget,approval_score)
      VALUES ($1,$2,$3,50)
      ON CONFLICT(election_id,candidate_user_id)
      DO UPDATE SET budget=EXCLUDED.budget
      RETURNING *
    `,[req.params.electionId,req.user.id,parsed.data.budget])).rows[0];
    res.json({campaign});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/elections/:electionId/polls",authRequired,async(req,res,next)=>{
  try{
    const rows=(await query(`
      SELECT u.username,pc.approval_score,
             COALESCE((SELECT support_percent FROM polls p WHERE p.election_id=pc.election_id AND p.candidate_user_id=pc.candidate_user_id ORDER BY created_at DESC LIMIT 1),pc.approval_score) AS support
      FROM political_campaigns pc JOIN users u ON u.id=pc.candidate_user_id
      WHERE pc.election_id=$1 ORDER BY support DESC
    `,[req.params.electionId])).rows;
    res.json({polls:rows});
  }catch(e){next(e);}
});

// ===== JUSTICE : APPEL =====
app.post("/api/world/:worldId/justice/cases/:caseId/appeal",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({reason:z.string().min(20).max(4000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Motif d'appel invalide"});
    const c=(await query(`SELECT * FROM court_cases WHERE id=$1 AND world_id=$2`,[req.params.caseId,req.params.worldId])).rows[0];
    if(!c||c.status!=="judged")return res.status(409).json({error:"Dossier non appelable"});
    if(![c.plaintiff_user_id,c.defendant_user_id].includes(req.user.id))
      return res.status(403).json({error:"Vous n'êtes pas partie au dossier"});
    const a=(await query(`
      INSERT INTO appeals(world_id,case_id,appellant_user_id,reason)
      VALUES ($1,$2,$3,$4) RETURNING *
    `,[req.params.worldId,c.id,req.user.id,parsed.data.reason])).rows[0];
    await query(`UPDATE court_cases SET status='appealed' WHERE id=$1`,[c.id]);
    await broadcastNews(req.params.worldId,"justice",`Appel déposé dans l'affaire #${c.id}`,{appealId:a.id});
    res.status(201).json({appeal:a});
  }catch(e){next(e);}
});

// ===== MODERATION / ANTI-ABUS =====
app.get("/api/admin/reports",adminKeyRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT r.*,ru.username AS reporter,tu.username AS reported
      FROM reports r
      JOIN users ru ON ru.id=r.reporter_user_id
      LEFT JOIN users tu ON tu.id=r.reported_user_id
      ORDER BY r.created_at DESC LIMIT 200
    `);
    res.json({reports:rows});
  }catch(e){next(e);}
});

app.post("/api/admin/users/:userId/moderate",adminKeyRequired,async(req,res,next)=>{
  try{
    const parsed=z.object({
      action:z.enum(['warning','mute','suspend','ban','unban']),
      reason:z.string().min(3).max(2000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Action invalide"});
    const userId=Number(req.params.userId);
    if(['ban','suspend'].includes(parsed.data.action))
      await query(`UPDATE users SET is_banned=TRUE WHERE id=$1`,[userId]);
    if(parsed.data.action==='unban')
      await query(`UPDATE users SET is_banned=FALSE WHERE id=$1`,[userId]);
    await query(`
      INSERT INTO moderation_actions(moderator_user_id,target_user_id,action,reason)
      VALUES ($1,$2,$3,$4)
    `,[userId,userId,parsed.data.action,parsed.data.reason]);
    res.json({ok:true});
  }catch(e){next(e);}
});



// ===== MODULE CONTROLE TECHNIQUE =====
app.get("/api/world/:worldId/inspection-centers",authRequired,async(req,res,next)=>{
  try{
    const {rows}=await query(`
      SELECT ic.*,c.name AS company_name,u.username AS owner_username
      FROM inspection_centers ic
      JOIN companies c ON c.id=ic.company_id
      JOIN users u ON u.id=ic.owner_user_id
      WHERE ic.world_id=$1 AND ic.active=TRUE
      ORDER BY ic.reputation DESC,ic.inspection_fee ASC
    `,[req.params.worldId]);
    res.json({centers:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/inspection-centers",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      companyId:z.number().int().positive(),
      name:z.string().min(3).max(120),
      inspectionFee:z.number().int().min(1000).max(1000000),
      revisitFee:z.number().int().min(0).max(500000)
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Centre invalide"});

    await assertCompatibleActivity(req.user.id,req.params.worldId,'inspection_center');

    const co=(await query(`
      SELECT * FROM companies
      WHERE id=$1 AND owner_user_id=$2 AND world_id=$3
      AND company_type='vehicle_inspection'
    `,[parsed.data.companyId,req.user.id,req.params.worldId])).rows[0];
    if(!co)return res.status(403).json({error:"Vous devez posséder une entreprise dédiée au contrôle technique"});

    const exists=(await query(`SELECT id FROM inspection_centers WHERE company_id=$1`,[co.id])).rows[0];
    if(exists)return res.status(409).json({error:"Ce garage possède déjà un centre de contrôle technique"});

    const accreditationCost=50000;
    const center=await withTransaction(async c=>{
      const w=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      if(Number(w.euros)<accreditationCost)
        throw Object.assign(new Error("50 000 € nécessaires pour obtenir l'agrément"),{status:409});
      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[accreditationCost,req.user.id]);
      const number=`CT-${req.params.worldId.toUpperCase()}-${Date.now()}-${req.user.id}`;
      const r=(await c.query(`
        INSERT INTO inspection_centers(
          world_id,company_id,owner_user_id,name,city,accreditation_number,inspection_fee,revisit_fee
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
      `,[req.params.worldId,co.id,req.user.id,parsed.data.name,co.city,number,
         parsed.data.inspectionFee,parsed.data.revisitFee])).rows[0];
      return r;
    });

    await broadcastNews(req.params.worldId,"automotive",
      `Nouveau centre de contrôle technique : ${center.name}`,
      {centerId:center.id,city:center.city});

    res.status(201).json({center});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.post("/api/world/:worldId/inspection-centers/:centerId/book",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      vehicleId:z.number().int().positive(),
      appointmentAt:z.string().datetime(),
      appointmentType:z.enum(['standard','revisit']).default('standard')
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Rendez-vous invalide"});

    const center=(await query(`
      SELECT * FROM inspection_centers
      WHERE id=$1 AND world_id=$2 AND active=TRUE
    `,[req.params.centerId,req.params.worldId])).rows[0];
    if(!center)return res.status(404).json({error:"Centre introuvable"});

    const vehicle=(await query(`
      SELECT * FROM vehicles
      WHERE id=$1 AND owner_user_id=$2 AND world_id=$3
    `,[parsed.data.vehicleId,req.user.id,req.params.worldId])).rows[0];
    if(!vehicle)return res.status(403).json({error:"Véhicule non autorisé"});

    const price=parsed.data.appointmentType==='revisit'
      ? Number(center.revisit_fee)
      : Number(center.inspection_fee);

    const appt=(await query(`
      INSERT INTO inspection_appointments(
        world_id,center_id,vehicle_id,customer_user_id,appointment_at,appointment_type,price
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `,[req.params.worldId,center.id,vehicle.id,req.user.id,parsed.data.appointmentAt,
       parsed.data.appointmentType,price])).rows[0];

    await notify(center.owner_user_id,req.params.worldId,"Nouveau rendez-vous contrôle technique",
      `${req.user.username} a réservé un contrôle pour le véhicule #${vehicle.id}.`);

    res.status(201).json({appointment:appt});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/inspection-centers/:centerId/appointments",authRequired,async(req,res,next)=>{
  try{
    const center=(await query(`
      SELECT * FROM inspection_centers
      WHERE id=$1 AND owner_user_id=$2 AND world_id=$3
    `,[req.params.centerId,req.user.id,req.params.worldId])).rows[0];
    if(!center)return res.status(403).json({error:"Centre non autorisé"});

    const {rows}=await query(`
      SELECT ia.*,v.make,v.model,v.year,v.mileage,v.condition,u.username AS customer
      FROM inspection_appointments ia
      JOIN vehicles v ON v.id=ia.vehicle_id
      JOIN users u ON u.id=ia.customer_user_id
      WHERE ia.center_id=$1
      ORDER BY ia.appointment_at ASC
    `,[center.id]);
    res.json({appointments:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/inspection-appointments/:appointmentId/perform",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      result:z.enum(['passed','failed','conditional']),
      notes:z.string().max(3000).default(""),
      defects:z.array(z.object({
        code:z.string().min(1).max(40),
        category:z.enum(['minor','major','critical']),
        description:z.string().min(3).max(1000)
      })).max(50).default([])
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Contrôle invalide"});

    const appt=(await query(`
      SELECT ia.*,ic.owner_user_id,ic.company_id,ic.name AS center_name,
             v.mileage,v.make,v.model
      FROM inspection_appointments ia
      JOIN inspection_centers ic ON ic.id=ia.center_id
      JOIN vehicles v ON v.id=ia.vehicle_id
      WHERE ia.id=$1 AND ia.world_id=$2
    `,[req.params.appointmentId,req.params.worldId])).rows[0];

    if(!appt||Number(appt.owner_user_id)!==req.user.id)
      return res.status(403).json({error:"Rendez-vous non autorisé"});
    if(appt.status==='completed')
      return res.status(409).json({error:"Contrôle déjà terminé"});

    const hasCritical=parsed.data.defects.some(d=>d.category==='critical');
    const hasMajor=parsed.data.defects.some(d=>d.category==='major');
    let finalResult=parsed.data.result;
    if(hasCritical) finalResult='failed';
    else if(hasMajor && finalResult==='passed') finalResult='conditional';

    const revisitRequired=finalResult!=='passed';
    const validUntil=finalResult==='passed'
      ? new Date(Date.now()+2*365*24*3600*1000).toISOString()
      : null;
    const revisitDue=revisitRequired
      ? new Date(Date.now()+2*30*24*3600*1000).toISOString()
      : null;

    const inspection=await withTransaction(async c=>{
      const customerWallet=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[appt.customer_user_id])).rows[0];
      if(Number(customerWallet.euros)<Number(appt.price))
        throw Object.assign(new Error("Le client ne dispose pas des fonds nécessaires"),{status:409});

      await c.query(`UPDATE wallets SET euros=euros-$1 WHERE user_id=$2`,[appt.price,appt.customer_user_id]);
      const ownerWallet=(await c.query(`SELECT euros FROM wallets WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];
      await c.query(`UPDATE wallets SET euros=$1 WHERE user_id=$2`,
        [Number(ownerWallet.euros)+Number(appt.price),req.user.id]);

      const inspectionNumber=`CT-${appt.vehicle_id}-${Date.now()}`;
      const ir=(await c.query(`
        INSERT INTO vehicle_inspections(
          vehicle_id,inspector_company_id,result,notes,mileage,valid_until,
          appointment_id,inspection_number,revisit_required,revisit_due_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `,[appt.vehicle_id,appt.company_id,finalResult,parsed.data.notes,appt.mileage,
         validUntil,appt.id,inspectionNumber,revisitRequired,revisitDue])).rows[0];

      for(const defect of parsed.data.defects){
        await c.query(`
          INSERT INTO inspection_defects(inspection_id,defect_code,category,description)
          VALUES ($1,$2,$3,$4)
        `,[ir.id,defect.code,defect.category,defect.description]);
      }

      await c.query(`UPDATE inspection_appointments SET status='completed' WHERE id=$1`,[appt.id]);
      await c.query(`UPDATE vehicles SET inspection_due_at=$1 WHERE id=$2`,
        [validUntil||revisitDue,appt.vehicle_id]);

      await c.query(`
        INSERT INTO vehicle_history(vehicle_id,event_type,actor_user_id,details)
        VALUES ($1,'TECHNICAL_INSPECTION',$2,$3::jsonb)
      `,[appt.vehicle_id,req.user.id,JSON.stringify({
        inspectionId:ir.id,result:finalResult,defects:parsed.data.defects.length,
        validUntil,revisitDue
      })]);

      return ir;
    });

    await notify(appt.customer_user_id,req.params.worldId,"Contrôle technique terminé",
      `${appt.make} ${appt.model} : résultat ${finalResult}.`);

    await broadcastNews(req.params.worldId,"automotive",
      `Contrôle technique terminé pour un ${appt.make} ${appt.model}`,
      {vehicleId:appt.vehicle_id,result:finalResult});

    res.json({inspection});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}
});

app.get("/api/world/:worldId/vehicles/:vehicleId/technical-inspection",authRequired,async(req,res,next)=>{
  try{
    const vehicle=(await query(`
      SELECT * FROM vehicles WHERE id=$1 AND world_id=$2
    `,[req.params.vehicleId,req.params.worldId])).rows[0];
    if(!vehicle)return res.status(404).json({error:"Véhicule introuvable"});

    const inspection=(await query(`
      SELECT vi.*,c.name AS inspector_company
      FROM vehicle_inspections vi
      LEFT JOIN companies c ON c.id=vi.inspector_company_id
      WHERE vi.vehicle_id=$1
      ORDER BY vi.created_at DESC LIMIT 1
    `,[vehicle.id])).rows[0]||null;

    let defects=[];
    if(inspection){
      defects=(await query(`SELECT * FROM inspection_defects WHERE inspection_id=$1 ORDER BY category DESC,id`,[inspection.id])).rows;
    }

    const now=Date.now();
    const valid=Boolean(
      inspection &&
      inspection.result==='passed' &&
      inspection.valid_until &&
      new Date(inspection.valid_until).getTime()>now
    );

    res.json({vehicle,inspection,defects,valid});
  }catch(e){next(e);}
});


app.post("/api/world/:worldId/press/media/:mediaId/roles",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const parsed=z.object({
      username:z.string().min(3).max(24),
      role:z.enum(['editor_in_chief','journalist'])
    }).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Rôle presse invalide"});

    const media=(await query(`
      SELECT * FROM media_outlets
      WHERE id=$1 AND world_id=$2 AND owner_user_id=$3
    `,[req.params.mediaId,req.params.worldId,req.user.id])).rows[0];
    if(!media)return res.status(403).json({error:"Média non autorisé"});

    const u=(await query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`,[parsed.data.username])).rows[0];
    if(!u)return res.status(404).json({error:"Joueur introuvable"});

    if(parsed.data.role==='editor_in_chief')
      await assertCompatibleActivity(Number(u.id),req.params.worldId,'editor_in_chief');

    await query(`
      INSERT INTO press_roles(media_id,user_id,role)
      VALUES ($1,$2,$3)
      ON CONFLICT(media_id,user_id) DO UPDATE SET role=EXCLUDED.role
    `,[media.id,u.id,parsed.data.role]);

    await notify(u.id,req.params.worldId,"Nouveau rôle presse",
      `Vous êtes nommé ${parsed.data.role==='editor_in_chief'?'rédacteur en chef':'journaliste'} de ${media.name}.`);

    res.json({ok:true});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message,code:e.code});next(e);}
});



// ===== LOBBY / PRESENCE / CHAT =====
app.get("/api/world/:worldId/lobby",authRequired,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    if(!['beta','world1'].includes(worldId))
      return res.status(400).json({error:"Monde invalide"});
    const online=(await query(`
      SELECT u.id,u.username,pp.last_seen_at,wp.city,wp.region,wp.reputation
      FROM player_presence pp
      JOIN users u ON u.id=pp.user_id
      LEFT JOIN world_profiles wp ON wp.user_id=u.id AND wp.world_id=pp.world_id
      WHERE pp.world_id=$1 AND pp.connected=TRUE
      ORDER BY pp.last_seen_at DESC LIMIT 200
    `,[worldId])).rows;
    const stats=(await query(`
      SELECT
        (SELECT COUNT(*)::int FROM world_profiles WHERE world_id=$1) AS registered_players,
        (SELECT COUNT(*)::int FROM player_presence WHERE world_id=$1 AND connected=TRUE) AS online_players,
        (SELECT COUNT(*)::int FROM companies WHERE world_id=$1) AS companies,
        (SELECT COUNT(*)::int FROM vehicles WHERE world_id=$1) AS vehicles,
        (SELECT COUNT(*)::int FROM market_listings WHERE world_id=$1 AND status='active') AS market_listings
    `,[worldId])).rows[0];
    res.json({online,stats});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/realtime-ticket",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    if(!['beta','world1'].includes(worldId))
      return res.status(400).json({error:"Monde invalide"});
    res.json({ticket:makeRealtimeTicket(req.user.id,worldId),expiresIn:60});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/chat/:channel",authRequired,async(req,res,next)=>{
  try{
    const channel=req.params.channel;
    if(!['general','trade','politics','press','help'].includes(channel))
      return res.status(400).json({error:"Canal invalide"});
    const rows=(await query(`
      SELECT m.id,m.channel,m.body,m.created_at,u.username
      FROM world_chat_messages m
      JOIN users u ON u.id=m.user_id
      WHERE m.world_id=$1 AND m.channel=$2
      ORDER BY m.created_at DESC LIMIT 100
    `,[req.params.worldId,channel])).rows.reverse();
    res.json({messages:rows});
  }catch(e){next(e);}
});

app.post("/api/world/:worldId/chat/:channel",authRequired,actionLimiter,async(req,res,next)=>{
  try{
    const channel=req.params.channel;
    if(!['general','trade','politics','press','help'].includes(channel))
      return res.status(400).json({error:"Canal invalide"});
    const parsed=z.object({body:z.string().trim().min(1).max(1000)}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Message invalide"});
    const msg=(await query(`
      INSERT INTO world_chat_messages(world_id,user_id,channel,body)
      VALUES ($1,$2,$3,$4)
      RETURNING id,channel,body,created_at
    `,[req.params.worldId,req.user.id,channel,parsed.data.body])).rows[0];
    await emitMultiplayerEvent(req.params.worldId,"world_chat",req.user.id,{
      ...msg,username:req.user.username
    });
    res.status(201).json({message:{...msg,username:req.user.username}});
  }catch(e){next(e);}
});

app.get("/api/world/:worldId/state",authRequired,async(req,res,next)=>{
  try{
    const worldId=req.params.worldId;
    const me=(await query(`
      SELECT u.id,u.username,wp.city,wp.region,wp.reputation,wp.game_day,w.euros,w.gold
      FROM users u
      JOIN world_profiles wp ON wp.user_id=u.id AND wp.world_id=$2
      JOIN wallets w ON w.user_id=u.id
      WHERE u.id=$1
    `,[req.user.id,worldId])).rows[0];
    const garage=(await query(`
      SELECT id,make,model,year,mileage,condition,estimated_value,status,vehicle_type,fuel_type,power_hp
      FROM vehicles WHERE owner_user_id=$1 AND world_id=$2
      ORDER BY created_at DESC
    `,[req.user.id,worldId])).rows;
    const companies=(await query(`
      SELECT id,name,company_type,city,region,cash,reputation
      FROM companies WHERE owner_user_id=$1 AND world_id=$2
      ORDER BY created_at DESC
    `,[req.user.id,worldId])).rows;
    res.json({me,garage,companies});
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
wss.on("connection",async(ws,req)=>{
  const id=wsSeq++;
  try{
    const url=new URL(req.url,"http://localhost");
    const auth=consumeRealtimeTicket(url.searchParams.get("ticket"));
    if(!auth){ws.close(4001,"unauthorized");return;}
    ws.worldId=auth.worldId;
    ws.userId=auth.userId;
    const ur=(await query(`SELECT username FROM users WHERE id=$1`,[auth.userId])).rows[0];
    ws.username=ur?.username||`Joueur ${auth.userId}`;
    liveClients.set(id,ws);
    realtimeUsers.set(id,{userId:ws.userId,worldId:ws.worldId,username:ws.username});
    await setPresence(ws.userId,ws.worldId,true);
    broadcast(ws.worldId,"presence_join",{userId:ws.userId,username:ws.username});
    ws.send(JSON.stringify({type:"connected",worldId:ws.worldId,payload:{userId:ws.userId,username:ws.username},ts:new Date().toISOString()}));
    ws.on("message",async data=>{
      try{
        const msg=JSON.parse(String(data));
        if(msg.type==="ping"){
          await setPresence(ws.userId,ws.worldId,true);
          ws.send(JSON.stringify({type:"pong",ts:new Date().toISOString()}));
        }
      }catch{}
    });
    ws.on("close",async()=>{
      liveClients.delete(id);
      realtimeUsers.delete(id);
      const still=[...realtimeUsers.values()].some(x=>x.userId===ws.userId&&x.worldId===ws.worldId);
      if(!still){
        await setPresence(ws.userId,ws.worldId,false);
        broadcast(ws.worldId,"presence_leave",{userId:ws.userId,username:ws.username});
      }
    });
  }catch(e){try{ws.close(1011,"server error")}catch{}}
});
httpServer.listen(port,()=>console.log(`Auto République API v1.1 sur http://localhost:${port}`));
