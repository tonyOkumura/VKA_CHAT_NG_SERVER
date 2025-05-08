import type { Knex } from 'knex';

const developmentConfig: Knex.Config = {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '241111',
    database: process.env.DB_NAME || 'vka_chat',
  },
  pool: {
    min: 2,
    max: 10
  },
  migrations: {
    tableName: 'knex_migrations',
    directory: '../db/migrations'
  },
  seeds: {
    directory: '../db/seeds'
  }
};

const config: { [key: string]: Knex.Config } = {
  development: developmentConfig,
};

export default config; 