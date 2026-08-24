
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

export async function query(text, params=[]){
  return pool.query(text, params);
}

export async function withTransaction(fn){
  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  }catch(err){
    await client.query("ROLLBACK");
    throw err;
  }finally{
    client.release();
  }
}

export async function createStarterData(userId){
  await withTransaction(async c=>{
    await c.query(
      `INSERT INTO wallets(user_id, euros, gold)
       VALUES ($1,250000,100)
       ON CONFLICT (user_id) DO NOTHING`, [userId]
    );
    for(const worldId of ["beta","world1"]){
      await c.query(
        `INSERT INTO world_profiles(user_id,world_id,reputation,city,region,game_day)
         VALUES ($1,$2,0,'Dijon','Bourgogne-Franche-Comté',1)
         ON CONFLICT (user_id,world_id) DO NOTHING`, [userId,worldId]
      );
    }
  });
}

export async function logAudit(userId, action, metadata, ip){
  await query(
    `INSERT INTO audit_log(user_id,action,metadata,ip)
     VALUES ($1,$2,$3,$4)`,
    [userId || null, action, metadata ? JSON.stringify(metadata) : null, ip || null]
  );
}
