import { MongoClient, type Db } from "mongodb";

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const DB_NAME = process.env.MONGO_DB_NAME ?? "webhook_inspector";

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;

  client = new MongoClient(MONGO_URL, {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE ?? 20),
  });
  await client.connect();
  db = client.db(DB_NAME);
  return db;
}

export function getDb(): Db {
  if (!db) {
    throw new Error("Mongo not connected — call connectMongo() first");
  }
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export async function pingMongo(): Promise<boolean> {
  try {
    await getDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
