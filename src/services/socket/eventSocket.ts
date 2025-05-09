import { Socket } from 'socket.io';
import { userSockets, emitToRoom } from './socketService';
import { ROOM_PREFIXES } from '../../config/constants';
import { isValidUUID, UpdateMyEventStatusData, getCachedUserDetails } from './socketUtils';
import knex from '../../lib/knex';

// Placeholder for rooms a socket is subscribed to for events, similar to socketTaskRooms
// export const socketEventRooms = new Map<string, Set<string>>();
const VALID_PARTICIPANT_STATUSES = ['invited', 'accepted', 'declined', 'maybe']; // Duplicated from controller, consider centralizing

/**
 * Handles a client's request to join a specific event room to receive real-time updates.
 */
export async function handleJoinEventRoom(socket: Socket, eventId: string): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(JSON.stringify({
            event: 'joinEventRoom',
            socketId: socket.id,
            eventId,
            status: 'failed',
            reason: 'Unauthenticated socket',
        }));
        socket.emit('joinEventRoom_failed', { eventId, errorCode: 'UNAUTHENTICATED', message: 'Socket not authenticated.' });
        return;
    }

    if (!isValidUUID(eventId)) {
        console.warn(JSON.stringify({
            event: 'joinEventRoom',
            userId,
            eventId,
            status: 'failed',
            reason: 'Invalid event ID format',
        }));
        socket.emit('joinEventRoom_failed', { eventId, errorCode: 'INVALID_ID', message: 'Invalid event ID format.' });
        return;
    }

    try {
        // Optional: Check if user is a participant or creator of the event before allowing to join room
        const isParticipant = await knex('event_participants')
            .where({ event_id: eventId, user_id: userId })
            .first();
        const event = await knex('events').where('id', eventId).select('creator_id').first();

        if (!isParticipant && (!event || event.creator_id !== userId)) {
            console.warn(JSON.stringify({
                event: 'joinEventRoom',
                userId,
                eventId,
                status: 'failed',
                reason: 'User is not creator or participant of the event',
            }));
            socket.emit('joinEventRoom_failed', { eventId, errorCode: 'ACCESS_DENIED', message: 'You do not have access to this event.' });
            return;
        }

        const roomName = `${ROOM_PREFIXES.EVENT}${eventId}`;
        socket.join(roomName);
        // socketEventRooms.get(socket.id)?.add(eventId); // If using socketEventRooms map

        console.log(JSON.stringify({
            event: 'joinEventRoom',
            userId,
            eventId,
            room: roomName,
            socketId: socket.id,
            status: 'success',
        }));
        socket.emit('joinEventRoom_success', { eventId, room: roomName });

    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'joinEventRoom',
            userId,
            eventId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to join event room',
        }));
        socket.emit('joinEventRoom_failed', { eventId, errorCode: 'SERVER_ERROR', message: 'Failed to join event room.' });
    }
}

/**
 * Handles a client's request to leave a specific event room.
 */
export async function handleLeaveEventRoom(socket: Socket, eventId: string): Promise<void> {
    const userId = userSockets.get(socket.id);
     if (!userId) {
        console.warn(JSON.stringify({
            event: 'leaveEventRoom',
            socketId: socket.id,
            eventId,
            status: 'ignored',
            reason: 'Unauthenticated socket on leave attempt',
        }));
        // Optionally emit failure, but often for leave it might be silent if socket is already gone
        return;
    }

    if (!isValidUUID(eventId)) {
        console.warn(JSON.stringify({
            event: 'leaveEventRoom',
            userId,
            eventId,
            status: 'ignored',
            reason: 'Invalid event ID format on leave attempt',
        }));
        return;
    }

    const roomName = `${ROOM_PREFIXES.EVENT}${eventId}`;
    socket.leave(roomName);
    // socketEventRooms.get(socket.id)?.delete(eventId); // If using socketEventRooms map

    console.log(JSON.stringify({
        event: 'leaveEventRoom',
        userId,
        eventId,
        room: roomName,
        socketId: socket.id,
        status: 'success',
    }));
    socket.emit('leaveEventRoom_success', { eventId, room: roomName });
}

/**
 * Handles a client's request to update their own participation status for an event.
 */
export async function handleUpdateMyEventStatus(socket: Socket, data: UpdateMyEventStatusData): Promise<void> {
    const userId = userSockets.get(socket.id);
    const { eventId, status } = data;

    if (!userId) {
        socket.emit('updateMyEventStatus_failed', { eventId, errorCode: 'UNAUTHENTICATED', message: 'Socket not authenticated.' });
        return;
    }

    if (!isValidUUID(eventId)) {
        socket.emit('updateMyEventStatus_failed', { eventId, errorCode: 'INVALID_EVENT_ID', message: 'Invalid event ID format.' });
        return;
    }

    if (!VALID_PARTICIPANT_STATUSES.includes(status)) {
        socket.emit('updateMyEventStatus_failed', { eventId, errorCode: 'INVALID_STATUS', message: `Invalid status. Must be one of: ${VALID_PARTICIPANT_STATUSES.join(', ')}` });
        return;
    }

    try {
        const event = await knex('events').select('id', 'creator_id').where('id', eventId).first();
        if (!event) {
            socket.emit('updateMyEventStatus_failed', { eventId, errorCode: 'EVENT_NOT_FOUND', message: 'Event not found.' });
            return;
        }

        // Creator cannot change their status from 'accepted' this way (they are auto-accepted)
        // If they want to decline/maybe after creation, it's a more complex flow perhaps via REST or admin action.
        if (userId === event.creator_id && status !== 'accepted') {
             socket.emit('updateMyEventStatus_failed', { eventId, errorCode: 'CREATOR_STATUS_LOCKED', message: 'Creator status is fixed as \'accepted\'.' });
             return;
        }

        const participant = await knex('event_participants')
            .where({ event_id: eventId, user_id: userId })
            .first();

        if (!participant) {
            socket.emit('updateMyEventStatus_failed', { eventId, errorCode: 'NOT_PARTICIPANT', message: 'You are not a participant of this event.' });
            return;
        }

        // Update status in DB
        await knex('event_participants')
            .where({ event_id: eventId, user_id: userId })
            .update({ status: status });

        // Fetch user details for the notification payload
        const userDetails = await getCachedUserDetails(userId);

        const payload = {
            eventId: eventId,
            userId: userId,
            newStatus: status,
            username: userDetails.username,
            avatarPath: userDetails.avatarPath
        };

        // Emit to the event room so all participants are updated
        const eventRoom = `${ROOM_PREFIXES.EVENT}${eventId}`;
        emitToRoom(eventRoom, 'eventParticipantStatusUpdated', payload);

        socket.emit('updateMyEventStatus_success', { eventId, newStatus: status });
        console.log(JSON.stringify({
            event: 'updateMyEventStatus',
            userId,
            eventId,
            newStatus: status,
            status: 'success',
        }));

    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'updateMyEventStatus',
            userId,
            eventId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to update event status',
        }));
        socket.emit('updateMyEventStatus_failed', { eventId, errorCode: 'SERVER_ERROR', message: 'Failed to update event status.' });
    }
}

// Add other event-specific socket handlers here if needed.
// For example, if a client directly wants to update their participation status via socket:
// export async function handleUpdateEventSelfStatus(socket: Socket, data: { eventId: string; status: string }): Promise<void> {
//    // ... implementation ...
// } 