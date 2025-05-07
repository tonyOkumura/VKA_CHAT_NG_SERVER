import { Server } from 'socket.io';

let _io: Server | null = null;

export const initializeSocketService = (socketIoInstance: Server): void => {
    if (_io) {
        console.warn('Socket.IO Service already initialized.');
        return;
    }
    _io = socketIoInstance;
    console.log('Socket.IO Service initialized successfully.');
};


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


export const emitToUser = (userId: string, event: string, data: any): void => {
   
    const userRoom = `user_${userId}`;
    emitToRoom(userRoom, event, data); // Reuse emitToRoom for user-specific room
};

