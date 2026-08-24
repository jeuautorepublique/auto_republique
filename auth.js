
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { query } from "./db.js";

const ACCESS_TTL = "15m";
const REFRESH_DAYS = 30;

function secret(){
  const s=process.env.JWT_SECRET||"";
  if(s.length<32) throw new Error("JWT_SECRET trop court.");
  return s;
}
export function createAccessToken(user){
  return jwt.sign({sub:String(user.id),username:user.username,type:"access"},secret(),{
    expiresIn:ACCESS_TTL,issuer:"auto-republique"
  });
}
export async function createRefreshToken(userId){
  const raw=crypto.randomBytes(48).toString("base64url");
  const hash=crypto.createHash("sha256").update(raw).digest("hex");
  const expires=new Date(Date.now()+REFRESH_DAYS*86400000).toISOString();
  await query(`INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,$3)`,
    [userId,hash,expires]);
  return raw;
}
export async function rotateRefreshToken(raw){
  const hash=crypto.createHash("sha256").update(raw||"").digest("hex");
  const {rows}=await query(`
    SELECT rt.*,u.username,u.email,u.is_banned
    FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
    WHERE rt.token_hash=$1 AND rt.revoked_at IS NULL
  `,[hash]);
  const row=rows[0];
  if(!row || new Date(row.expires_at).getTime()<=Date.now() || row.is_banned) return null;
  await query(`UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=$1`,[row.id]);
  const refresh=await createRefreshToken(row.user_id);
  const access=createAccessToken({id:row.user_id,username:row.username});
  return {access,refresh,user:{id:row.user_id,username:row.username,email:row.email}};
}
export async function revokeRefreshToken(raw){
  const hash=crypto.createHash("sha256").update(raw||"").digest("hex");
  await query(`UPDATE refresh_tokens SET revoked_at=NOW() WHERE token_hash=$1`,[hash]);
}
export function authRequired(req,res,next){
  const token=req.cookies?.ar_access;
  if(!token) return res.status(401).json({error:"Non connecté"});
  try{
    const p=jwt.verify(token,secret(),{issuer:"auto-republique"});
    req.user={id:Number(p.sub),username:p.username};
    next();
  }catch{res.status(401).json({error:"Session expirée"});}
}
export function setAuthCookies(res,access,refresh){
  const secure=String(process.env.COOKIE_SECURE).toLowerCase()==="true";
  const common={httpOnly:true,secure,sameSite:"lax",path:"/"};
  res.cookie("ar_access",access,{...common,maxAge:15*60*1000});
  res.cookie("ar_refresh",refresh,{...common,maxAge:30*86400000});
}
export function clearAuthCookies(res){
  const secure=String(process.env.COOKIE_SECURE).toLowerCase()==="true";
  const common={httpOnly:true,secure,sameSite:"lax",path:"/"};
  res.clearCookie("ar_access",common);res.clearCookie("ar_refresh",common);
}
