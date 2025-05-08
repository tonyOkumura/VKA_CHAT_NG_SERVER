import { Socket } from 'socket.io';
import { fetchAllDialogParticipants } from '../../lib/dbHelpers';
import { emitToRoom, userSockets } from './socketService';
import { ROOM_PREFIXES } from '../../config/constants';
import { getCachedUserDetails, isValidUUID } from './socketUtils';

export async function handleJoinDialog(socket: Socket, dialogId: string): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(JSON.stringify({
            event: 'joinDialog',
            socketId: socket.id,
            dialogId,
            status: 'failed',
            reason: 'Unauthenticated socket',
        }));
        return;
    }

    if (!isValidUUID(dialogId)) {
        socket.emit('joinDialog_failed', { errorCode: 'INVALID_ID', message: 'Invalid dialog ID format' });
        return;
    }

    const room = `${ROOM_PREFIXES.DIALOG}${dialogId}`;
    socket.join(room);
    console.log(JSON.stringify({
        event: 'joinDialog',
        userId,
        dialogId,
        socketId: socket.id,
        status: 'success',
    }));

    try {
        const participants = await fetchAllDialogParticipants(dialogId);
        if (!participants.some((p) => p.id === userId)) {
            console.warn(JSON.stringify({
                event: 'joinDialog',
                userId,
                dialogId,
                status: 'failed',
                reason: 'User is not a participant',
            }));
            socket.emit('joinDialog_failed', {
                errorCode: 'NOT_PARTICIPANT',
                message: 'You are not a participant of this dialog',
            });
            return;
        }

        const userDetails = await getCachedUserDetails(userId);
        emitToRoom(room, 'userJoinedDialog', {
            dialog_id: dialogId,
            user_id: userId,
            avatarUrl: userDetails.avatarPath,
            joined_at: new Date().toISOString(),
        });
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'joinDialog',
            userId,
            dialogId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to join dialog',
        }));
        socket.emit('joinDialog_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to join dialog',
        });
    }
}