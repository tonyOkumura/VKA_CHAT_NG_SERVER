import { Socket } from 'socket.io';
import knex from '../../lib/knex';
import { emitToUser, userSockets } from './socketService';
import { ContactAddedData, getCachedUserDetails, isValidUUID } from './socketUtils';

export async function handleContactAdded(socket: Socket, data: ContactAddedData): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId || userId !== data.user_id) {
        console.warn(JSON.stringify({
            event: 'contactAdded',
            socketId: socket.id,
            userId: data.user_id,
            status: 'failed',
            reason: 'Auth mismatch',
        }));
        return;
    }

    if (!isValidUUID(data.contact_id)) {
        socket.emit('contactAdded_failed', {
            errorCode: 'INVALID_ID',
            message: 'Invalid contact ID format',
        });
        return;
    }

    try {
        const contactUser = await getCachedUserDetails(data.contact_id);
        emitToUser(data.contact_id, 'contactAdded', {
            contact: {
                id: userId,
                username: (await getCachedUserDetails(userId)).username,
                avatarUrl: (await getCachedUserDetails(userId)).avatarPath,
                isOnline: (await knex('users').select('is_online as isOnline').where('id', userId).first())?.isOnline || false,
            },
        });
        console.log(JSON.stringify({
            event: 'contactAdded',
            userId,
            contactId: data.contact_id,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'contactAdded',
            userId,
            contactId: data.contact_id,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to process contact added event',
        }));
        socket.emit('contactAdded_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to process contact added event',
        });
    }
}