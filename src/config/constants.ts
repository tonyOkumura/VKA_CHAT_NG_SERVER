export const HOST = process.env.HOST || '0.0.0.0';
export const PORT = Number(process.env.PORT) || 6000;
export const CORS_ORIGIN = '*';
export const ROOM_PREFIXES = {
    USER: 'user:',
    DIALOG: 'dialog:',
    GROUP: 'group:',
    TASK: 'task:',
    GENERAL_TASKS: 'general_tasks',
  };