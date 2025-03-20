import { Pool } from 'pg';

const pool = new Pool({
    user: 'postgres',
    password: '241111',
    host: 'localhost',
    port: 5432,
    database: 'vka_chat'
});

export default pool;
