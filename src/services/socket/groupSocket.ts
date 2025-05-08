import { Socket } from 'socket.io';
import { fetchAllGroupParticipants } from '../../lib/dbHelpers';
import { emitToRoom, userSockets } from './socketService';
import { ROOM_PREFIXES } from '../../config/constants';
import { getCachedUserDetails, isValidUUID } from './socketUtils';

export async function handleJoinGroup(socket: Socket, groupId: string): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(JSON.stringify({
            event: 'joinGroup',
            socketId: socket.id,
            groupId,
            status: 'failed',
            reason: 'Unauthenticated socket',
        }));
        return;
    }

    if (!isValidUUID(groupId)) {
        socket.emit('joinGroup_failed', { errorCode: 'INVALID_ID', message: 'Invalid group ID format' });
        return;
    }

    const room = `${ROOM_PREFIXES.GROUP}${groupId}`;
    socket.join(room);
    console.log(JSON.stringify({
        event: 'joinGroup',
        userId,
        groupId,
        socketId: socket.id,
        status: 'success',
    }));

    try {
        const participants = await fetchAllGroupParticipants(groupId);
        if (!participants.some((p) => p.id === userId)) {
            console.warn(JSON.stringify({
                event: 'joinGroup',
                userId,
                groupId,
                status: 'failed',
                reason: 'User is not a participant',
            }));
            socket.emit('joinGroup_failed', {
                errorCode: 'NOT_PARTICIPANT',
                message: 'You are not a participant of this group',
            });
            return;
        }

        const userDetails = await getCachedUserDetails(userId);
        emitToRoom(room, 'userJoinedGroup', {
            group_id: groupId,
            user_id: userId,
            avatarUrl: userDetails.avatarPath,
            joined_at: new Date().toISOString(),
        });
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'joinGroup',
            userId,
            groupId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to join group',
        }));
        socket.emit('joinGroup_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to join group',
        });
    }
}