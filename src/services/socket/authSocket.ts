import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { updateUserOnlineStatus } from '../../controllers/userController';
import { emitToAll, userSockets } from './socketService';
import { ROOM_PREFIXES } from '../../config/constants';
import { getCachedUserDetails, isValidUUID, socketTaskRooms } from './socketUtils';

const JWT_SECRET = process.env.JWT_SECRET || 'worisecretkey';

export async function handleAuthenticate(socket: Socket, token: string): Promise<void> {
    try {
        if (!token) {
            throw new Error('Token is required');
        }
        const decoded = jwt.verify(token, JWT_SECRET) as { id: string; username: string };
        const userId = decoded.id;

        if (!isValidUUID(userId)) {
            throw new Error('Invalid user ID format');
        }

        userSockets.set(socket.id, userId);
        socketTaskRooms.set(socket.id, new Set<string>());

        const userRoom = `${ROOM_PREFIXES.USER}${userId}`;
        socket.join(userRoom);
        socket.join(ROOM_PREFIXES.GENERAL_TASKS);

        await updateUserOnlineStatus(userId, true);

        const userDetails = await getCachedUserDetails(userId);
        emitToAll('userStatusChanged', {
            userId,
            isOnline: true,
            username: userDetails.username,
            avatarUrl: userDetails.avatarPath,
        });
        console.log(JSON.stringify({
            event: 'authenticate',
            userId,
            username: userDetails.username,
            socketId: socket.id,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'authenticate',
            socketId: socket.id,
            errorCode: error.code || 'AUTH_FAILED',
            errorMessage: error.message || 'Authentication failed',
        }));
        socket.emit('authentication_failed', {
            errorCode: error.code || 'AUTH_FAILED',
            message: error.message || 'Authentication failed',
        });
    }
}