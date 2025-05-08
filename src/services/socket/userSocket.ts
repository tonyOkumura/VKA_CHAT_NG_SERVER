import { Server, Socket } from 'socket.io';
import knex from '../../lib/knex';
import { emitToAll, emitToUser, userSockets } from './socketService';
import { ROOM_PREFIXES } from '../../config/constants';
import { NotificationData, getCachedUserDetails, isValidUUID, socketTaskRooms } from './socketUtils';
import { v4 as uuidv4 } from 'uuid';

export async function handleNotification(socket: Socket, data: NotificationData): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId || userId !== data.user_id) {
        console.warn(JSON.stringify({
            event: 'notification',
            socketId: socket.id,
            userId: data.user_id,
            status: 'failed',
            reason: 'Auth mismatch',
        }));
        return;
    }

    if (!data.type || !data.content || data.content.length > 500) {
        socket.emit('notification_failed', {
            errorCode: 'INVALID_INPUT',
            message: 'Notification type and content are required, content must not exceed 500 characters',
        });
        return;
    }

    if ((data.related_dialog_id && !isValidUUID(data.related_dialog_id)) || (data.related_group_id && !isValidUUID(data.related_group_id))) {
        socket.emit('notification_failed', {
            errorCode: 'INVALID_ID',
            message: 'Invalid dialog or group ID format',
        });
        return;
    }

    try {
        const notification = await knex('notifications')
            .insert({
                id: uuidv4(),
                user_id: data.user_id,
                type: data.type,
                content: data.content,
                related_dialog_id: data.related_dialog_id,
                related_group_id: data.related_group_id,
                created_at: new Date(),
            })
            .returning(['id', 'user_id', 'type', 'content', 'related_dialog_id', 'related_group_id', 'created_at']);

        emitToUser(data.user_id, 'notification', {
            ...notification[0],
            created_at: new Date(notification[0].created_at).toISOString(),
        });
        console.log(JSON.stringify({
            event: 'notification',
            userId: data.user_id,
            notificationId: notification[0].id,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'notification',
            userId: data.user_id,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to send notification',
        }));
        socket.emit('notification_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to send notification',
        });
    }
}

export async function handleDeleteAccount(socket: Socket, io: Server): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(JSON.stringify({
            event: 'deleteAccount',
            socketId: socket.id,
            status: 'failed',
            reason: 'Unauthenticated socket',
        }));
        return;
    }

    try {
        const user = await getCachedUserDetails(userId);
        const contacts = await knex('contacts')
            .select('contact_id')
            .where('user_id', userId);

        userSockets.forEach((uid, socketId) => {
            if (uid === userId) {
                const sock = io.sockets.sockets.get(socketId);
                if (sock) {
                    sock.disconnect(true);
                }
                userSockets.delete(socketId);
                socketTaskRooms.delete(socketId);
            }
        });

        contacts.forEach(({ contact_id }) => {
            emitToUser(contact_id, 'contactRemoved', {
                userId,
                username: user.username,
            });
        });

        emitToAll('userStatusChanged', {
            userId,
            isOnline: false,
            username: user.username,
            avatarUrl: user.avatarPath,
        });
        console.log(JSON.stringify({
            event: 'deleteAccount',
            userId,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'deleteAccount',
            userId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to delete account',
        }));
        socket.emit('deleteAccount_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to delete account',
        });
    }
}

export async function handleDisconnect(socket: Socket, reason: string): Promise<void> {
    const userId = userSockets.get(socket.id);
    console.log(JSON.stringify({
        event: 'disconnect',
        socketId: socket.id,
        userId,
        reason,
    }));

    if (userId) {
        try {
            const taskRooms = socketTaskRooms.get(socket.id);
            taskRooms?.forEach((taskId) => {
                socket.leave(`${ROOM_PREFIXES.TASK}${taskId}`);
            });

            socket.leave(`${ROOM_PREFIXES.USER}${userId}`);
            socket.leave(ROOM_PREFIXES.GENERAL_TASKS);

            userSockets.delete(socket.id);
            socketTaskRooms.delete(socket.id);

            const hasOtherConnections = Array.from(userSockets.values()).some((uid) => uid === userId);
            if (!hasOtherConnections) {
                const user = await getCachedUserDetails(userId);
                await knex('users').where('id', userId).update({ is_online: false });
                emitToAll('userStatusChanged', {
                    userId,
                    isOnline: false,
                    username: user.username,
                    avatarUrl: user.avatarPath,
                });
                console.log(JSON.stringify({
                    event: 'userOffline',
                    userId,
                    status: 'success',
                }));
            }
        } catch (error: any) {
            console.error(JSON.stringify({
                event: 'disconnect',
                userId,
                errorCode: error.code || 'DB_ERROR',
                errorMessage: error.message || 'Error handling disconnect',
            }));
        }
    }
}