import knexConstructor, { Knex } from 'knex';
import knexConfig from '../config/knexfile'; // Обновленный путь

// Определяем, какую конфигурацию использовать (например, на основе NODE_ENV)
// Для простоты пока используем 'development'
const environment = process.env.NODE_ENV || 'development';
const configOptions = knexConfig[environment]; // Переименовал, чтобы избежать конфликта имен с модулем config

if (!configOptions) {
  throw new Error(`Knex configuration for environment "${environment}" not found.`);
}

const knex: Knex = knexConstructor(configOptions);

export default knex; 