import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { saveMessage } from '../controllers/messagesController';
import { fetchAllDialogParticipants, fetchAllGroupParticipants, getUserDetailsWithAvatar } from '../lib/dbHelpers';
import { updateUserOnlineStatus } from '../controllers/userController';
import knex from '../lib/knex';
import { emitToRoom, emitToAll, emitToUser, userSockets } from './socketService';
import { ROOM_PREFIXES } from '../config/constants';
import { v4 as uuidv4 } from 'uuid';

// Интерфейсы для типизации входных данных
interface MessageData {
    dialog_id?: string;
    group_id?: string;
    sender_id: string;
    content: string;
    mentions?: string[];
    fileIds?: string[];
    replied_to_message_id?: string;
}

interface NotificationData {
    user_id: string;
    type: string;
    content: string;
    related_dialog_id?: string;
    related_group_id?: string;
}

interface ContactAddedData {
    user_id: string;
    contact_id: string;
}

interface TypingData {
    dialog_id?: string;
    group_id?: string;
    user_id: string;
}

interface MarkMessagesAsReadData {
    dialog_id?: string;
    group_id?: string;
    message_ids: string[];
}

// Лимиты для защиты от спама
const MESSAGE_RATE_LIMIT = {
    maxMessages: 10,
    windowMs: 60 * 1000, // 1 минута
};
const userMessageTimestamps = new Map<string, number[]>();

// Кэш для userDetails
const userDetailsCache = new Map<string, { username: string; avatarPath: string | null; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

// Валидация UUID
const isValidUUID = (str: string): boolean => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
};

// Проверка лимитов сообщений
const checkRateLimit = (userId: string): boolean => {
    const now = Date.now();
    const timestamps = userMessageTimestamps.get(userId) || [];
    const recentTimestamps = timestamps.filter(ts => now - ts < MESSAGE_RATE_LIMIT.windowMs);
    
    if (recentTimestamps.length >= MESSAGE_RATE_LIMIT.maxMessages) {
        return false;
    }
    
    recentTimestamps.push(now);
    userMessageTimestamps.set(userId, recentTimestamps);
    return true;
};

// Мемоизация getUserDetailsWithAvatar
const getCachedUserDetails = async (userId: string): Promise<{ username: string; avatarPath: string | null }> => {
    const cached = userDetailsCache.get(userId);
    const now = Date.now();
    
    if (cached && now - cached.timestamp < CACHE_TTL) {
        return { username: cached.username, avatarPath: cached.avatarPath };
    }
    
    const details = await getUserDetailsWithAvatar(userId);
    if (!details.username) {
        throw new Error('User not found');
    }
    
    userDetailsCache.set(userId, {
        username: details.username,
        avatarPath: details.avatarPath,
        timestamp: now,
    });
    
    return { username: details.username, avatarPath: details.avatarPath };
};

const socketTaskRooms = new Map<string, Set<string>>();
const JWT_SECRET = process.env.JWT_SECRET || 'worisecretkey';

export function setupSocketHandlers(io: Server): void {
    io.on('connection', (socket: Socket) => {
        console.log(`User connected: ${socket.id}`);

        socket.on('authenticate', async (token: string) => handleAuthenticate(socket, token));
        socket.on('joinDialog', async (dialogId: string) => handleJoinDialog(socket, dialogId));
        socket.on('joinGroup', async (groupId: string) => handleJoinGroup(socket, groupId));
        socket.on('markMessagesAsRead', async (data: MarkMessagesAsReadData) =>
            handleMarkMessagesAsRead(socket, data));
        socket.on('sendMessage', async (message: MessageData) => handleSendMessage(socket, message));
        socket.on('editMessage', async (data: { message_id: string; content: string }) =>
            handleEditMessage(socket, data));
        socket.on('start_typing', (data: TypingData) => handleTyping(socket, data, true));
        socket.on('stop_typing', (data: TypingData) => handleTyping(socket, data, false));
        socket.on('joinTaskDetails', (taskId: string) => handleJoinTaskDetails(socket, taskId, true));
        socket.on('leaveTaskDetails', (taskId: string) => handleJoinTaskDetails(socket, taskId, false));
        socket.on('notification', async (data: NotificationData) => handleNotification(socket, data));
        socket.on('contactAdded', async (data: ContactAddedData) => handleContactAdded(socket, data));
        socket.on('deleteAccount', async () => handleDeleteAccount(socket, io));
        socket.on('disconnect', async (reason: string) => handleDisconnect(socket, reason));
    });
}

async function handleAuthenticate(socket: Socket, token: string): Promise<void> {
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

async function handleJoinDialog(socket: Socket, dialogId: string): Promise<void> {
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

async function handleJoinGroup(socket: Socket, groupId: string): Promise<void> {
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

async function handleMarkMessagesAsRead(
    socket: Socket,
    { dialog_id, group_id, message_ids }: MarkMessagesAsReadData
): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(JSON.stringify({
            event: 'markMessagesAsRead',
            socketId: socket.id,
            status: 'failed',
            reason: 'Unauthenticated socket',
        }));
        return;
    }

    if (!message_ids || message_ids.length === 0) {
        console.warn(JSON.stringify({
            event: 'markMessagesAsRead',
            userId,
            status: 'failed',
            reason: 'No message IDs provided',
        }));
        return;
    }

    if (!dialog_id && !group_id) {
        socket.emit('markMessagesAsRead_failed', {
            errorCode: 'MISSING_ID',
            message: 'dialog_id or group_id is required',
        });
        return;
    }

    if (dialog_id && group_id) {
        socket.emit('markMessagesAsRead_failed', {
            errorCode: 'INVALID_INPUT',
            message: 'Specify either dialog_id or group_id, not both',
        });
        return;
    }

    if ((dialog_id && !isValidUUID(dialog_id)) || (group_id && !isValidUUID(group_id))) {
        socket.emit('markMessagesAsRead_failed', {
            errorCode: 'INVALID_ID',
            message: 'Invalid dialog or group ID format',
        });
        return;
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;
    const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;

    try {
        const isParticipant = conversationType === 'dialog'
            ? await knex('dialog_participants').where({ dialog_id: conversationId, user_id: userId }).first()
            : await knex('group_participants').where({ group_id: conversationId, user_id: userId }).first();

        if (!isParticipant) {
            socket.emit('markMessagesAsRead_failed', {
                errorCode: 'NOT_PARTICIPANT',
                message: `You are not a participant of this ${conversationType}`,
            });
            return;
        }

        // Валидация message_ids
        if (!message_ids.every(id => isValidUUID(id))) {
            socket.emit('markMessagesAsRead_failed', {
                errorCode: 'INVALID_MESSAGE_IDS',
                message: 'One or more message IDs have invalid format',
            });
            return;
        }

        const readEntries = message_ids.map((msgId) => ({
            message_id: msgId,
            user_id: userId,
            read_at: new Date(),
        }));
        await knex('message_reads')
            .insert(readEntries)
            .onConflict(['message_id', 'user_id'])
            .ignore();

        const userDetails = await getCachedUserDetails(userId);
        const payload = {
            dialog_id: dialog_id || undefined,
            group_id: group_id || undefined,
            user_id: userId,
            avatarUrl: userDetails.avatarPath,
            message_ids,
            read_at: new Date().toISOString(),
        };

        emitToRoom(room, 'messagesRead', payload);
        console.log(JSON.stringify({
            event: 'markMessagesAsRead',
            userId,
            conversationType,
            conversationId,
            messageIds: message_ids,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'markMessagesAsRead',
            userId,
            conversationType,
            conversationId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to mark messages as read',
        }));
        socket.emit('markMessagesAsRead_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to mark messages as read',
        });
    }
}

async function handleSendMessage(socket: Socket, message: MessageData): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId || userId !== message.sender_id) {
        socket.emit('sendMessage_failed', {
            errorCode: 'AUTH_MISMATCH',
            message: 'Authentication mismatch or user not authenticated',
        });
        return;
    }

    const { dialog_id, group_id, sender_id, content, mentions = [], fileIds = [], replied_to_message_id } = message;

    if (!dialog_id && !group_id) {
        socket.emit('sendMessage_failed', {
            errorCode: 'MISSING_ID',
            message: 'dialog_id or group_id is required',
        });
        return;
    }

    if (dialog_id && group_id) {
        socket.emit('sendMessage_failed', {
            errorCode: 'INVALID_INPUT',
            message: 'Specify either dialog_id or group_id, not both',
        });
        return;
    }

    if (!content && (!fileIds || fileIds.length === 0)) {
        socket.emit('sendMessage_failed', {
            errorCode: 'EMPTY_MESSAGE',
            message: 'Message content or files cannot be empty',
        });
        return;
    }

    if ((dialog_id && !isValidUUID(dialog_id)) || (group_id && !isValidUUID(group_id))) {
        socket.emit('sendMessage_failed', {
            errorCode: 'INVALID_ID',
            message: 'Invalid dialog or group ID format',
        });
        return;
    }

    if (content && content.length > 2000) {
        socket.emit('sendMessage_failed', {
            errorCode: 'CONTENT_TOO_LONG',
            message: 'Message content exceeds 2000 characters',
        });
        return;
    }

    if (!checkRateLimit(userId)) {
        socket.emit('sendMessage_failed', {
            errorCode: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many messages sent, please wait',
        });
        return;
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;
    const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;

    try {
        const isParticipant = conversationType === 'dialog'
            ? await knex('dialog_participants').where({ dialog_id: conversationId, user_id: userId }).first()
            : await knex('group_participants').where({ group_id: conversationId, user_id: userId }).first();

        if (!isParticipant) {
            socket.emit('sendMessage_failed', {
                errorCode: 'NOT_PARTICIPANT',
                message: `You are not a participant of this ${conversationType}`,
            });
            return;
        }

        // Валидация mentions и fileIds
        if (mentions.some(id => !isValidUUID(id)) || fileIds.some(id => !isValidUUID(id))) {
            socket.emit('sendMessage_failed', {
                errorCode: 'INVALID_IDS',
                message: 'Invalid mention or file ID format',
            });
            return;
        }

        if (replied_to_message_id && !isValidUUID(replied_to_message_id)) {
            socket.emit('sendMessage_failed', {
                errorCode: 'INVALID_REPLY_ID',
                message: 'Invalid replied-to message ID format',
            });
            return;
        }

        const savedMessage = await saveMessage(
            { dialog_id, group_id },
            sender_id,
            content || '',
            mentions,
            fileIds,
            replied_to_message_id
        );
        if (!savedMessage) {
            throw new Error('Failed to save message or retrieve its details');
        }

        emitToRoom(room, 'newMessage', savedMessage);

        const participants = conversationType === 'dialog'
            ? await fetchAllDialogParticipants(conversationId)
            : await fetchAllGroupParticipants(conversationId);

        const memberIds = participants.map((p: any) => p.id);
        memberIds.forEach((memberId: string) => {
            if (memberId !== sender_id) {
                emitToUser(memberId, 'notification', {
                    type: 'new_message',
                    content: `New message from ${savedMessage.sender_username || sender_id}`,
                    related_dialog_id: dialog_id || undefined,
                    related_group_id: group_id || undefined,
                    related_message_id: savedMessage.id,
                });
            }
        });

        mentions.forEach((mentionedUserId: string) => {
            if (mentionedUserId !== sender_id) {
                emitToUser(mentionedUserId, 'notification', {
                    type: 'mention',
                    content: `You were mentioned by ${savedMessage.sender_username || sender_id}`,
                    related_dialog_id: dialog_id || undefined,
                    related_group_id: group_id || undefined,
                    related_message_id: savedMessage.id,
                });
            }
        });

        await knex('message_reads')
            .insert({
                message_id: savedMessage.id,
                user_id: sender_id,
                read_at: new Date(),
            })
            .onConflict(['message_id', 'user_id'])
            .ignore();

        const senderDetails = await getCachedUserDetails(sender_id);
        emitToRoom(room, 'messageReadUpdate', {
            dialog_id: dialog_id || undefined,
            group_id: group_id || undefined,
            message_id: savedMessage.id,
            user_id: sender_id,
            username: senderDetails.username,
            avatarUrl: senderDetails.avatarPath,
            read_at: new Date().toISOString(),
        });

        console.log(JSON.stringify({
            event: 'sendMessage',
            userId,
            conversationType,
            conversationId,
            messageId: savedMessage.id,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'sendMessage',
            userId,
            conversationType,
            conversationId,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to send message',
        }));
        socket.emit('sendMessage_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: error.message || 'Failed to send message',
            originalMessage: message,
        });
    }
}

async function handleEditMessage(socket: Socket, { message_id, content }: { message_id: string; content: string }): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        socket.emit('editMessage_failed', {
            errorCode: 'AUTH_MISMATCH',
            message: 'User not authenticated',
        });
        return;
    }

    if (!isValidUUID(message_id)) {
        socket.emit('editMessage_failed', {
            errorCode: 'INVALID_ID',
            message: 'Invalid message ID format',
        });
        return;
    }

    if (!content || content.length > 2000) {
        socket.emit('editMessage_failed', {
            errorCode: 'INVALID_CONTENT',
            message: 'Message content must be non-empty and not exceed 2000 characters',
        });
        return;
    }

    try {
        const message = await knex('messages')
            .select('sender_id', 'dialog_id', 'group_id')
            .where('id', message_id)
            .first();

        if (!message) {
            socket.emit('editMessage_failed', {
                errorCode: 'MESSAGE_NOT_FOUND',
                message: 'Message not found',
            });
            return;
        }

        if (message.sender_id !== userId) {
            socket.emit('editMessage_failed', {
                errorCode: 'PERMISSION_DENIED',
                message: 'You can only edit your own messages',
            });
            return;
        }

        const conversationType = message.dialog_id ? 'dialog' : 'group';
        const conversationId = message.dialog_id || message.group_id!;
        const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;

        await knex('messages')
            .where('id', message_id)
            .update({
                content,
                updated_at: new Date(),
            });

        const updatedMessage = await knex('messages')
            .select('id', 'dialog_id', 'group_id', 'sender_id', 'content', 'updated_at')
            .where('id', message_id)
            .first();

        const senderDetails = await getCachedUserDetails(userId);
        emitToRoom(room, 'messageEdited', {
            message_id,
            dialog_id: updatedMessage.dialog_id || undefined,
            group_id: updatedMessage.group_id || undefined,
            sender_id: updatedMessage.sender_id,
            content: updatedMessage.content,
            sender_username: senderDetails.username,
            avatarUrl: senderDetails.avatarPath,
            updated_at: new Date(updatedMessage.updated_at).toISOString(),
        });

        console.log(JSON.stringify({
            event: 'editMessage',
            userId,
            messageId: message_id,
            conversationType,
            conversationId,
            status: 'success',
        }));
    } catch (error: any) {
        console.error(JSON.stringify({
            event: 'editMessage',
            userId,
            messageId: message_id,
            errorCode: error.code || 'DB_ERROR',
            errorMessage: error.message || 'Failed to edit message',
        }));
        socket.emit('editMessage_failed', {
            errorCode: error.code || 'DB_ERROR',
            message: 'Failed to edit message',
        });
    }
}

function handleTyping(
    socket: Socket,
    { dialog_id, group_id, user_id }: TypingData,
    isTyping: boolean
): void {
    const authenticatedUserId = userSockets.get(socket.id);
    if (!authenticatedUserId || authenticatedUserId !== user_id) {
        console.warn(JSON.stringify({
            event: isTyping ? 'startTyping' : 'stopTyping',
            socketId: socket.id,
            userId: user_id,
            status: 'failed',
            reason: 'Auth mismatch',
        }));
        return;
    }

    if (!dialog_id && !group_id) {
        console.warn(JSON.stringify({
            event: isTyping ? 'startTyping' : 'stopTyping',
            userId: user_id,
            status: 'failed',
            reason: 'Missing dialog_id or group_id',
        }));
        return;
    }

    if (dialog_id && group_id) {
        console.warn(JSON.stringify({
            event: isTyping ? 'startTyping' : 'stopTyping',
            userId: user_id,
            status: 'failed',
            reason: 'Both dialog_id and group_id specified',
        }));
        return;
    }

    if ((dialog_id && !isValidUUID(dialog_id)) || (group_id && !isValidUUID(group_id))) {
        console.warn(JSON.stringify({
            event: isTyping ? 'startTyping' : 'stopTyping',
            userId: user_id,
            status: 'failed',
            reason: 'Invalid dialog or group ID format',
        }));
        return;
    }

    const conversationType = dialog_id ? 'dialog' : 'group';
    const conversationId = dialog_id || group_id!;
    const room = conversationType === 'dialog' ? `${ROOM_PREFIXES.DIALOG}${conversationId}` : `${ROOM_PREFIXES.GROUP}${conversationId}`;

    const event = isTyping ? 'user_typing' : 'user_stopped_typing';
    socket.to(room).emit(event, { dialog_id, group_id, user_id });
    console.log(JSON.stringify({
        event: isTyping ? 'startTyping' : 'stopTyping',
        userId: user_id,
        conversationType,
        conversationId,
        status: 'success',
    }));
}

async function handleJoinTaskDetails(socket: Socket, taskId: string, join: boolean): Promise<void> {
    const userId = userSockets.get(socket.id);
    if (!userId) {
        console.warn(JSON.stringify({
            event: join ? 'joinTaskDetails' : 'leaveTaskDetails',
            socketId: socket.id,
            taskId,
            status: 'failed',
            reason: 'Unauthenticated socket',
        }));
        return;
    }

    if (!isValidUUID(taskId)) {
        console.warn(JSON.stringify({
            event: join ? 'joinTaskDetails' : 'leaveTaskDetails',
            userId,
            taskId,
            status: 'failed',
            reason: 'Invalid task ID format',
        }));
        return;
    }

    const roomName = `${ROOM_PREFIXES.TASK}${taskId}`;
    if (join) {
        socket.join(roomName);
        socketTaskRooms.get(socket.id)?.add(taskId);

        const task = await knex('tasks')
            .select('id', 'title', 'status', 'created_at', 'updated_at')
            .where('id', taskId)
            .first();

        if (task) {
            emitToRoom(roomName, 'taskStatus', {
                taskId,
                title: task.title,
                status: task.status,
                created_at: new Date(task.created_at).toISOString(),
                updated_at: new Date(task.updated_at).toISOString(),
            });
        }
    } else {
        socket.leave(roomName);
        socketTaskRooms.get(socket.id)?.delete(taskId);
    }
    console.log(JSON.stringify({
        event: join ? 'joinTaskDetails' : 'leaveTaskDetails',
        userId,
        taskId,
        status: 'success',
    }));
}

async function handleNotification(
    socket: Socket,
    data: NotificationData
): Promise<void> {
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

async function handleContactAdded(
    socket: Socket,
    data: ContactAddedData
): Promise<void> {
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

async function handleDeleteAccount(socket: Socket, io: Server): Promise<void> {
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

async function handleDisconnect(socket: Socket, reason: string): Promise<void> {
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
                await updateUserOnlineStatus(userId, false);
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