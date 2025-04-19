import { Server } from 'socket.io';

let _io: Server | null = null;

/**
 * Initializes the Socket.IO service with the server instance.
 * Should be called once during server startup.
 * @param socketIoInstance The Socket.IO Server instance.
 */
export const initializeSocketService = (socketIoInstance: Server): void => {
    if (_io) {
        console.warn('Socket.IO Service already initialized.');
        return;
    }
    _io = socketIoInstance;
    console.log('Socket.IO Service initialized successfully.');
};

/**
 * Emits an event to a specific room.
 * @param room The name of the room.
 * @param event The name of the event.
 * @param data The data to send with the event.
 */
export const emitToRoom = (room: string, event: string, data: any): void => {
    console.log(`[Debug Socket Service] Вызов emitToRoom для комнаты '${room}', события '${event}'`);
    if (!_io) {
        console.error('!!! [Socket Service] Socket.IO Service не инициализирован. Не могу отправить событие.');
        return;
    }
    console.log(`[Debug Socket Service] Экземпляр _io существует.`);
    try {
        console.log(`[Socket Service Emit] Event: ${event} | Target: Room ${room} | Data: ${JSON.stringify(data)}`);
        _io.to(room).emit(event, data);
        console.log(`[Debug Socket Service] Вызов _io.to('${room}').emit('${event}') завершен (вроде бы).`);
    } catch (emitError: any) {
        console.error(`!!! [Socket Service] ОШИБКА при вызове _io.to(...).emit(...) для комнаты ${room}:`, emitError);
    }
};

/**
 * Emits an event to all connected clients.
 * @param event The name of the event.
 * @param data The data to send with the event.
 */
export const emitToAll = (event: string, data: any): void => {
    console.log(`[Debug Socket Service] Вызов emitToAll для события '${event}'`);
    if (!_io) {
        console.error('!!! [Socket Service] Socket.IO Service не инициализирован. Не могу отправить событие.');
        return;
    }
    console.log(`[Debug Socket Service] Экземпляр _io существует.`);
    try {
        console.log(`[Socket Service Emit] Event: ${event} | Target: All | Data: ${JSON.stringify(data)}`);
        _io.emit(event, data);
        console.log(`[Debug Socket Service] Вызов _io.emit('${event}') завершен (вроде бы).`);
    } catch (emitError: any) {
        console.error(`!!! [Socket Service] ОШИБКА при вызове _io.emit(...) для события ${event}:`, emitError);
    }
};

/**
 * Emits an event to a specific user's personal room (user_{userId}).
 * @param userId The ID of the target user.
 * @param event The name of the event.
 * @param data The data to send with the event.
 */
export const emitToUser = (userId: string, event: string, data: any): void => {
    if (!userId) {
        console.warn('[Socket Service] Attempted to emit to a null/undefined userId.');
        return;
    }
    const userRoom = `user_${userId}`;
    emitToRoom(userRoom, event, data); // Reuse emitToRoom for user-specific room
};

// Add more specific emit functions if needed (e.g., emitToSocketId, emitToAllExceptSender) 