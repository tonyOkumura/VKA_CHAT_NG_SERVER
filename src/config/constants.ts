export const HOST = process.env.HOST || '0.0.0.0';
export const PORT = Number(process.env.PORT) || 6000;
export const CORS_ORIGIN = '*';
export const ROOM_PREFIXES = {
    USER: 'USER',
    DIALOG: 'DIALOG',
    GROUP: 'GROUP',
    TASK: 'TASK',
    EVENT: 'EVENT',
    GENERAL_TASKS: 'GENERAL_TASKS',
  };

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// TODO: Add other constants as needed