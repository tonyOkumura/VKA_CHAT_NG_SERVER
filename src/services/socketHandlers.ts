import { Server, Socket } from 'socket.io';
import { saveMessage } from '../controllers/messagesController';
import { 
    fetchAllParticipantsByConversationIdForMessages 
} from '../lib/dbHelpers';
import { updateUserOnlineStatus } from '../controllers/userController';
import knex from '../lib/knex';
import { emitToRoom, emitToAll, emitToUser } from './socketService';
import { ROOM_PREFIXES } from '../config/constants';

const userSockets = new Map<string, string>();
const socketTaskRooms = new Map<string, Set<string>>();

export function setupSocketHandlers(io: Server): void {
    io.on('connection', (socket: Socket) => {
        console.log(`User connected: ${socket.id}`);

        socket.on('authenticate', async (userId: string) => handleAuthenticate(socket, userId));
        socket.on('joinConversation', async (conversationId: string) => handleJoinConversation(socket, conversationId));
        socket.on('markMessagesAsRead', async (data: { conversation_id: string; message_ids: string[] }) =>
            handleMarkMessagesAsRead(socket, data));
        socket.on('sendMessage', async (message: any) => handleSendMessage(socket, message));
        socket.on('start_typing', (data: { conversation_id: string; user_id: string }) => handleTyping(socket, data, true));
        socket.on('stop_typing', (data: { conversation_id: string; user_id: string }) => handleTyping(socket, data, false));
        socket.on('joinTaskDetails', (taskId: string) => handleTaskRoom(socket, taskId, true));
        socket.on('leaveTaskDetails', (taskId: string) => handleTaskRoom(socket, taskId, false));
        socket.on('disconnect', async (reason: string) => handleDisconnect(socket, reason));
    });
}

async function handleAuthenticate(socket: Socket, userId: string): Promise<void> {
    try {
        userSockets.set(socket.id, userId);
        socketTaskRooms.set(socket.id, new Set<string>());

        const userRoom = `${ROOM_PREFIXES.USER}${userId}`;
        socket.join(userRoom);
        socket.join(ROOM_PREFIXES.GENERAL_TASKS);

        await updateUserOnlineStatus(userId, true);

        const userDetails = await knex('users as u')
            .select('u.username', 'ua.file_path as avatarUrl')
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .where('u.id', userId)
            .first();

        emitToAll('userStatusChanged', { 
            userId, 
            isOnline: true, 
            username: userDetails?.username,
            avatarUrl: userDetails?.avatarUrl 
        });
        console.log(`User ${userId} authenticated and joined rooms (username: ${userDetails?.username})`);
    } catch (error: any) {
        console.error(`Authentication error for user ${userId}:`, error);
        socket.emit('authentication_failed', { message: error.message || 'Authentication failed' });
    }
}

async function handleJoinConversation(socket: Socket, conversationId: string): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(`Unauthenticated socket ${socket.id} tried to join conversation ${conversationId}`);
        return;
    }

    socket.join(conversationId);
    console.log(`User ${userId} joined conversation: ${conversationId}`);

    try {
        const participants = await fetchAllParticipantsByConversationIdForMessages(conversationId);
        const readerDetails = await knex('user_avatars')
            .select('file_path as avatarUrl')
            .where('user_id', userId)
            .first();
        const readerAvatarUrl = readerDetails?.avatarUrl || null;

        if (participants) {
            emitToRoom(conversationId, 'userJoinedConversation', {
                conversation_id: conversationId,
                user_id: userId,
                avatarUrl: readerAvatarUrl, 
                joined_at: new Date(),
            });
        }
    } catch (error: any) {
        console.error(`Error processing join conversation for ${conversationId}:`, error);
    }
}

async function handleMarkMessagesAsRead(socket: Socket, { conversation_id, message_ids }: { conversation_id: string; message_ids: string[] }): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(`Unauthenticated socket ${socket.id} tried to mark messages as read`);
        return;
    }
    if (!message_ids || message_ids.length === 0) {
        console.warn(`User ${userId} tried to mark zero messages as read in ${conversation_id}`);
        return;
    }

    try {
        const readEntries = message_ids.map(msgId => ({ message_id: msgId, user_id: userId, read_at: new Date() }));
        await knex('message_reads')
            .insert(readEntries)
            .onConflict(['message_id', 'user_id'])
            .ignore();

        const readerDetails = await knex('user_avatars')
            .select('file_path as avatarUrl')
            .where('user_id', userId)
            .first();
        const readerAvatarUrl = readerDetails?.avatarUrl || null;

        emitToRoom(conversation_id, 'messagesRead', {
            conversation_id,
            user_id: userId,
            avatarUrl: readerAvatarUrl,
            message_ids,
            read_at: new Date().toISOString(),
        });

        console.log(`User ${userId} marked messages ${message_ids.join(', ')} as read in conversation ${conversation_id}`);
    } catch (error: any) {
        console.error(`Error marking messages as read for user ${userId}:`, error);
        socket.emit('markMessagesAsRead_failed', { error: 'Failed to mark messages as read' });
    }
}

async function handleSendMessage(socket: Socket, message: any): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId || userId !== message.sender_id) {
        socket.emit('sendMessage_failed', { message: 'Authentication mismatch or user not authenticated' });
        return;
    }

    const { conversation_id, sender_id, content, mentions = [], fileIds = [], replied_to_message_id } = message;
    if (!content && (!fileIds || fileIds.length === 0)) { 
        socket.emit('sendMessage_failed', { message: 'Message content or files cannot be empty', originalMessage: message });
        return;
    }

    try {
        const savedMessage = await saveMessage(conversation_id, sender_id, content || '', mentions, fileIds, replied_to_message_id);
        if (!savedMessage) {
            throw new Error('Failed to save message or retrieve its details.');
        }
        emitToRoom(conversation_id, 'newMessage', savedMessage);

        const participants = await fetchAllParticipantsByConversationIdForMessages(conversation_id);
        if (!participants) throw new Error('Failed to fetch participants for notifications');

        const memberIds = participants.map((p: any) => p.id);
        memberIds.forEach((memberId: string) => {
            if (memberId !== sender_id) {
                emitToUser(memberId, 'notification', {
                    type: 'new_message',
                    content: `New message from ${savedMessage.sender_username || sender_id}`,
                    related_conversation_id: conversation_id,
                    related_message_id: savedMessage.id,
                });
            }
        });

        mentions.forEach((mentionedUserId: string) => {
            if (mentionedUserId !== sender_id) {
                emitToUser(mentionedUserId, 'notification', {
                    type: 'mention',
                    content: `You were mentioned by ${savedMessage.sender_username || sender_id}`,
                    related_conversation_id: conversation_id,
                    related_message_id: savedMessage.id,
                });
            }
        });

        await knex('message_reads')
            .insert({
                message_id: savedMessage.id,
                user_id: sender_id,
                read_at: new Date()
            })
            .onConflict(['message_id', 'user_id'])
            .ignore(); 

        const senderDetails = await knex('users as u')
            .select('u.username', 'ua.file_path as avatarUrl')
            .leftJoin('user_avatars as ua', 'u.id', 'ua.user_id')
            .where('u.id', sender_id)
            .first();

        emitToRoom(conversation_id, 'messageReadUpdate', {
            conversation_id,
            message_id: savedMessage.id,
            user_id: sender_id,
            username: senderDetails?.username,
            avatarUrl: senderDetails?.avatarUrl,
            read_at: new Date().toISOString(),
        });
    } catch (error: any) {
        console.error(`Failed to send message from user ${userId}:`, error);
        socket.emit('sendMessage_failed', { message: error.message || 'Failed to send message', originalMessage: message });
    }
}

function handleTyping(socket: Socket, { conversation_id, user_id }: { conversation_id: string; user_id: string }, isTyping: boolean): void {
    const authenticatedUserId = userSockets.get(socket.id);
    if (!authenticatedUserId || authenticatedUserId !== user_id) {
        console.warn(`Auth mismatch for typing event from socket ${socket.id}`);
        return;
    }

    const event = isTyping ? 'user_typing' : 'user_stopped_typing';
    socket.to(conversation_id).emit(event, { conversation_id, user_id });
    console.log(`User ${user_id} ${isTyping ? 'started' : 'stopped'} typing in conversation ${conversation_id}`);
}

function handleTaskRoom(socket: Socket, taskId: string, join: boolean): void {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(`Unauthenticated socket ${socket.id} tried to ${join ? 'join' : 'leave'} task room ${taskId}`);
        return;
    }

    const roomName = `${ROOM_PREFIXES.TASK}${taskId}`;
    if (join) {
        socket.join(roomName);
        socketTaskRooms.get(socket.id)?.add(taskId);
    } else {
        socket.leave(roomName);
        socketTaskRooms.get(socket.id)?.delete(taskId);
    }
    console.log(`User ${userId} ${join ? 'joined' : 'left'} task room: ${roomName}`);
}

async function handleDisconnect(socket: Socket, reason: string): Promise<void> {
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
    const userId = userSockets.get(socket.id);

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
                await updateUserOnlineStatus(userId, false);
                emitToAll('userStatusChanged', { userId, isOnline: false });
                console.log(`User ${userId} marked offline`);
            }
        } catch (error: any) {
            console.error(`Error handling disconnect for user ${userId}:`, error);
        }
    }
} 